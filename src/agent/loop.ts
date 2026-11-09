import { buildRecallPrefix, isRecallTriggered } from './recall.ts';
import {
  estimateTokens,
  keepRecentTurns,
  requestCompaction,
} from './compaction.ts';
import {
  buildStaticSystemPrompt,
  buildTurnTimePrefix,
  composeTurnMessages,
} from './prompt.ts';
import { runToolLoop } from './tool-loop.ts';
import { mergeToolRuntimes, type AgentToolRuntime } from './tool-runtime.ts';
import type { FactTag } from '../memory/facts.ts';
import type { FactsStore } from '../memory/facts.ts';
import type { SelfNoteStore } from '../memory/selfnote.ts';
import type { Retriever } from '../memory/retriever/types.ts';
import type { EventStore, RecordSource } from '../memory/store.ts';
import {
  ProviderAbortError,
  type ChatMessage,
  type Provider,
  type TokenUsage,
} from '../provider/types.ts';
import { readSessionState, writeSessionState } from '../state/persist.ts';
import type { AgentWebToolRuntime } from '../tools/web/index.ts';

export interface AgentMemoryOptions {
  facts: FactsStore;
  selfNotes: SelfNoteStore;
  retriever: Retriever;
  recall: { trigger: 'auto' | 'off'; budgetChars: number; budgetItems: number };
}

export interface AgentCompactionOptions {
  enabled: boolean;
  idleMs: number;
  thresholdTokens: number;
  /** 历史达到至少 N 个完整轮次后才允许按轮次触发；默认 6。 */
  minTurns?: number;
  sessionStateDir: string;
}

export interface AgentOptions {
  provider: Provider;
  store: EventStore;
  persona: string;
  /** 当前 owner 人格卡（PersonaCardStore.promptText() 的初始值）。 */
  personaCard?: string;
  /** 每轮从磁盘重新读取人格卡；返回空串表示无卡。 */
  reloadPersonaCard?: () => string;
  sessionKey: string;
  /** 入口来源，CLI 为 cli，QQ 线接入后为 qq。 */
  src?: RecordSource;
  /** 保留最近多少轮进上下文窗口，默认 20 轮（= 40 条消息）。 */
  historyTurns?: number;
  now?: () => number;
  /** 记忆内核；不传则与 P0 行为一致（不注入、不复习、不检索）。 */
  memory?: AgentMemoryOptions;
  /** 压缩；不传则从不压缩。 */
  compaction?: AgentCompactionOptions;
  /** 测试/外部注入摘要（优先于 state 里持久化的摘要）。 */
  summary?: string;
  onWarn?: (message: string) => void;
  onInfo?: (message: string) => void;
}

export interface TurnResult {
  text: string;
  interrupted: boolean;
  usage: TokenUsage | null;
}

export interface ConsolidationResult {
  ok: boolean;
  reason?: string;
  facts?: number;
  selfNotes?: number;
}

export interface RunTurnOptions {
  signal: AbortSignal;
  onText?: (chunk: string) => void;
  /**
   * 本轮启用的联网工具 runtime。传入时走有界工具循环；不传时保持
   * 原有纯文本实时流式路径。是否向调用方暴露由上层权限判断决定。
   */
  webTools?: AgentWebToolRuntime;
  /** 本轮启用的记忆工具 runtime（owner-only）。与 webTools 一起进入同一工具循环。 */
  memoryTools?: AgentToolRuntime;
  /** 本轮启用的代码任务工具 runtime（owner-only）。 */
  codeTools?: AgentToolRuntime;
  /** 仅测试/内部注入：工具整轮 deadline，默认 120000ms。 */
  roundTimeoutMs?: number;
  /**
   * 是否由 Agent 写 user L0，默认 true（CLI 兼容）。
   * QQ 线传 false：/hook 接收层是唯一 user L0 写入方，避免双写。
   */
  writeUserL0?: boolean;
  /**
   * 是否由 Agent 写 assistant L0 并推入 history，默认 true。
   * 传 false 时只返回生成文本，由发送收尾按实际送达结果决定是否落盘。
   */
  writeAssistantL0?: boolean;
}

const EMPTY_USAGE: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

/**
 * Agent 闭环（P1）：
 * - sys 静态段 = persona + personaCard + STATIC_RULES + 长期记忆 + selfNote + 摘要；
 *   facts 内容不变时逐轮相同
 * - 检索只进动态段（本轮 user 消息前缀【回忆】），且只在触发词命中时才检索
 * - 消息到达时跑一次 autoReview（零 token 开销）
 * - 闲置边界压缩：记忆整理 → 写盘成功 → 截断历史 → 摘要持久化
 *
 * 三段边界（P2 T4a）：
 * 1) 原始记录（L0）：user 记录由入口负责（QQ 接收层唯一写入；CLI 默认由本类写入）；
 *    assistant 只在确认写入语义后落盘（CLI 立即写；QQ 等发送收尾，见 T4c）。
 * 2) 模型输入：静态段 + history + 本轮 user，可带【回忆】注入；L0 永远存原文。
 * 3) 发送收尾：ReplyPlan/SendResult 之后按实际送达写 assistant L0；本类不实现。
 */
export class Agent {
  private readonly provider: Provider;
  private readonly store: EventStore;
  private readonly sessionKey: string;
  private readonly src: RecordSource;
  private readonly historyTurns: number;
  private readonly now: () => number;
  private readonly persona: string;
  private readonly reloadPersonaCardSource: (() => string) | undefined;
  private readonly memory: AgentMemoryOptions | undefined;
  private readonly compaction: AgentCompactionOptions | undefined;
  private readonly onWarn: (message: string) => void;
  private readonly onInfo: (message: string) => void;

  private personaCardText: string;
  private selfNoteText: string;
  private summary: string | null;
  private systemPrompt = '';
  private staticFingerprint = '';

  private history: ChatMessage[] = [];
  private totalUsage: TokenUsage = { ...EMPTY_USAGE };

  /**
   * 待发送收尾标记（T4a seam）：
   * 仅当本轮以 writeAssistantL0=false 生成非空文本时置位，commitAssistant 消费一次。
   */
  private hasPendingAssistantCommit = false;

  private lastTurnAt: number;
  private compactionFailedAt: number | null = null;
  /** 距上次成功整理的新增轮数；历史本身会被裁剪，不能用 history.length 代替。 */
  private turnsSinceCompaction = 0;
  private warnedStateWriteFailure = false;
  private warnedPersonaCardReloadFailure = false;

  constructor(options: AgentOptions) {
    this.provider = options.provider;
    this.store = options.store;
    this.sessionKey = options.sessionKey;
    this.src = options.src ?? 'cli';
    this.historyTurns = options.historyTurns ?? 20;
    this.now = options.now ?? Date.now;
    this.persona = options.persona;
    this.personaCardText = (options.personaCard ?? '').trim();
    this.reloadPersonaCardSource = options.reloadPersonaCard;
    this.memory = options.memory;
    this.compaction = options.compaction;
    this.onWarn = options.onWarn ?? ((message) => console.warn(message));
    this.onInfo = options.onInfo ?? ((message) => console.log(message));

    // selfNote 启动时加载，并随写入刷新；下一轮起进入静态段。
    this.selfNoteText = this.memory ? this.memory.selfNotes.bootstrapText(this.sessionKey) : '';

    // 重启恢复：L0 / facts / selfNote 都在磁盘上；这里恢复摘要、模型历史和整理边界。
    const persisted = this.compaction
      ? readSessionState(this.compaction.sessionStateDir, this.sessionKey)
      : null;
    this.summary = options.summary ?? (persisted?.summary || null);

    const restoredHistory = persisted?.history ?? [];
    const maxRestoredMessages = Math.max(0, this.historyTurns * 2);
    this.history =
      maxRestoredMessages === 0 ? [] : restoredHistory.slice(-maxRestoredMessages);
    this.turnsSinceCompaction = persisted?.turnsSinceCompaction ?? 0;
    const restoredLastTurnAt = persisted?.lastTurnAt
      ? Date.parse(persisted.lastTurnAt)
      : Number.NaN;
    this.lastTurnAt = Number.isFinite(restoredLastTurnAt) ? restoredLastTurnAt : this.now();
    this.rebuildStaticPrompt();
  }

  get historyMessageCount(): number {
    return this.history.length;
  }

  get usageTotals(): TokenUsage {
    return { ...this.totalUsage };
  }

  get factsCount(): number {
    return this.memory ? this.memory.facts.count(this.sessionKey) : 0;
  }

  get selfNoteCount(): number {
    return this.memory ? this.memory.selfNotes.count(this.sessionKey) : 0;
  }

  get hasSummary(): boolean {
    return this.summary !== null && this.summary.length > 0;
  }

  /** 当前静态 system 段（测试与 /status 用）。 */
  get staticPrompt(): string {
    return this.systemPrompt;
  }

  async runTurn(userText: string, opts: RunTurnOptions): Promise<TurnResult> {
    const writeUserL0 = opts.writeUserL0 ?? true;
    const writeAssistantL0 = opts.writeAssistantL0 ?? true;
    const toolRuntime = mergeToolRuntimes([
      opts.webTools,
      opts.memoryTools,
      opts.codeTools,
    ]);

    // 新一轮开始：上一轮未提交的回复作废，防止迟到/重复提交。
    this.hasPendingAssistantCommit = false;

    if (toolRuntime && this.provider.supportsTools !== true) {
      throw new Error('当前 Provider 不支持工具调用');
    }

    if (toolRuntime && toolRuntime.ownerSessionKey !== this.sessionKey) {
      throw new Error('工具 runtime 的 ownerSessionKey 与当前会话不匹配');
    }

    // 传入 runtime 即表示本回合启用工具；每回合只重置一次整轮预算。
    if (toolRuntime) toolRuntime.beginTurn();

    // 人格卡每轮从磁盘刷新；owner 手工改文件或 !人格/!称呼 下一轮即生效。
    this.refreshPersonaCard();

    // 闲置边界 + 上下文超阈值才压缩；忙时（本函数开始后）不会触发。
    await this.maybeCompact();

    // 消息到达：自动复习钩子只跑这一次（零 token 成本，不进模型调用）。
    this.memory?.facts.autoReview(this.sessionKey, userText);
    // 外部/上一轮可能刚写入 selfNote（含 CLI !note 或中断的工具轮）；每轮开始对齐一次。
    this.refreshSelfNote();
    this.rebuildStaticPrompt();

    // 动态时间 + 触发式检索：只在本轮输入加前缀，绝不进静态段、L0 或 history。
    const turnTimePrefix = buildTurnTimePrefix(this.now());
    let effectiveText = userText;
    if (this.memory && isRecallTriggered(userText, this.memory.recall.trigger)) {
      const prefix = await buildRecallPrefix({
        query: userText,
        retriever: this.memory.retriever,
        sessionKey: this.sessionKey,
        budgetChars: this.memory.recall.budgetChars,
        budgetItems: this.memory.recall.budgetItems,
      });
      if (prefix.length > 0) effectiveText = `${prefix}${userText}`;
    }
    effectiveText = `${turnTimePrefix}${effectiveText}`;

    // 轮次开始：先把用户原话落 L0（即使模型调用失败，用户说过的话也不丢）。
    // 注意：落盘的是原文，不含【回忆】注入块。
    // QQ 线由接收层在 ACK 前写好 user L0，此处传 writeUserL0=false 避免双写。
    if (writeUserL0) this.appendRecord('user', userText);

    const messages = composeTurnMessages({
      systemPrompt: this.systemPrompt,
      history: this.history,
      userText: effectiveText,
    });

    let assistantText = '';
    let interrupted = false;
    let turnUsage: TokenUsage | null = null;

    try {
      if (!toolRuntime) {
        for await (const event of this.provider.chat(
          { sessionId: this.sessionKey, messages },
          { signal: opts.signal },
        )) {
          if (event.type === 'text') {
            assistantText += event.text;
            opts.onText?.(event.text);
            continue;
          }

          if (event.type === 'usage') {
            const usage = this.provider.usageOf(event);
            if (usage) {
              turnUsage = usage;
              this.totalUsage = {
                promptTokens: this.totalUsage.promptTokens + usage.promptTokens,
                completionTokens: this.totalUsage.completionTokens + usage.completionTokens,
                totalTokens: this.totalUsage.totalTokens + usage.totalTokens,
              };
            }
          }
        }
      } else {
        const toolLoop = await runToolLoop({
          provider: this.provider,
          sessionKey: this.sessionKey,
          messages,
          webTools: toolRuntime,
          signal: opts.signal,
          roundTimeoutMs: opts.roundTimeoutMs,
        });
        assistantText = toolLoop.text;
        turnUsage = toolLoop.usage;
        if (toolLoop.usage) {
          this.totalUsage = {
            promptTokens: this.totalUsage.promptTokens + toolLoop.usage.promptTokens,
            completionTokens:
              this.totalUsage.completionTokens + toolLoop.usage.completionTokens,
            totalTokens: this.totalUsage.totalTokens + toolLoop.usage.totalTokens,
          };
        }
        if (assistantText.length > 0) opts.onText?.(assistantText);
        // 工具轮可能刚写入 selfNote；让下一轮立刻看到，不必等进程重启。
        this.refreshSelfNote();
      }
    } catch (err) {
      if (!(err instanceof ProviderAbortError)) throw err;
      // 工具轮的中断向外传播，且不留下任何半截 assistant 持久化。
      if (toolRuntime) throw err;
      interrupted = true;
    } finally {
      this.lastTurnAt = this.now();
    }

    if (assistantText.length > 0) {
      // 轮次结束：落 assistant 原文（中断产生的半截回复也保留，以文件为准）。
      // QQ 线传 writeAssistantL0=false：只返回文本，等发送收尾按实际送达落盘。
      if (writeAssistantL0) this.appendRecord('assistant', assistantText);
      else this.hasPendingAssistantCommit = true;
    }

    // 内存历史存原文：避免下一轮把【回忆】块当成历史再喂一遍。
    this.history.push({ role: 'user', content: userText });
    if (writeAssistantL0 && assistantText.length > 0) {
      this.history.push({ role: 'assistant', content: assistantText });
    }
    this.trimHistory();
    this.turnsSinceCompaction += 1;
    this.persistSessionState();

    return { text: assistantText, interrupted, usage: turnUsage };
  }

  /**
   * 发送收尾 seam（T4b，不含发送）：提交实际送达的 assistant 文本。
   *
   * 只在上一次 runTurn 以 writeAssistantL0=false 生成非空文本后可用；
   * T4c 按 sentIndexes 把实际送达的 messages 按原序拼成一个字符串后调用一次。
   * 可选写 L0（writeL0 !== false），并推入 history；一次成功提交后标记清除，重复调用被拒绝。
   */
  commitAssistant(text: string, opts: { writeL0?: boolean } = {}): void {
    if (!this.hasPendingAssistantCommit) {
      throw new Error(
        'commitAssistant 被拒绝：没有待提交的回复（未以 writeAssistantL0=false 生成文本，或已提交）',
      );
    }
    if (text.trim().length === 0) {
      throw new Error('commitAssistant 被拒绝：提交文本不能为空（没有实际送达内容时不要调用）');
    }

    if (opts.writeL0 !== false) this.appendRecord('assistant', text);
    this.history.push({ role: 'assistant', content: text });
    this.trimHistory();
    this.hasPendingAssistantCommit = false;
    this.persistSessionState();
  }

  /**
   * owner 手动整理：绕过 idle/token/minTurns，其余步骤与自动压缩共用
   * runCompaction。失败不截断历史，也不抛出。
   */
  async consolidateNow(options?: { signal?: AbortSignal }): Promise<ConsolidationResult> {
    if (!this.memory) return { ok: false, reason: '记忆层不可用' };
    if (this.history.length === 0) return { ok: false, reason: '没有可整理的对话历史' };
    if (!this.compaction) return { ok: false, reason: '压缩未配置' };
    return this.runCompaction({ force: true, signal: options?.signal });
  }

  private appendRecord(role: 'user' | 'assistant', text: string): void {
    this.store.append({
      src: this.src,
      sessionKey: this.sessionKey,
      role,
      text,
      t: this.now(),
    });
  }

  /**
   * 摘要变化时才重建静态段；否则复用同一个字符串（前缀缓存纪律）。
   * facts 的注入文案本身是「当前权重排序」的结果，作为指纹的一部分。
   */
  private rebuildStaticPrompt(): void {
    const factsLine = this.memory ? this.memory.facts.selectForInjection(this.sessionKey) : '';
    const fingerprint = `${factsLine}\u0000${this.personaCardText}\u0000${this.selfNoteText}\u0000${this.summary ?? ''}`;
    if (fingerprint === this.staticFingerprint && this.systemPrompt.length > 0) return;

    this.staticFingerprint = fingerprint;
    this.systemPrompt = buildStaticSystemPrompt(this.persona, {
      personaCard: this.personaCardText,
      factsLine,
      selfNote: this.selfNoteText,
      summary: this.summary ?? undefined,
    });
  }

  /**
   * selfNote 写入后刷新静态段；下一次模型请求生效。
   * 未写入时保持同一字符串，不破坏前缀缓存纪律。
   */
  refreshSelfNote(): void {
    const next = this.memory ? this.memory.selfNotes.bootstrapText(this.sessionKey) : '';
    if (next === this.selfNoteText) return;
    this.selfNoteText = next;
    this.rebuildStaticPrompt();
  }

  /**
   * 人格卡写入后刷新静态段；下一次模型请求生效。
   * 未配置 reload 时只有构造参数生效；读取失败沿用上一轮内容。
   */
  refreshPersonaCard(): void {
    if (!this.reloadPersonaCardSource) return;

    let next: string;
    try {
      next = this.reloadPersonaCardSource().trim();
      this.warnedPersonaCardReloadFailure = false;
    } catch (err) {
      if (!this.warnedPersonaCardReloadFailure) {
        this.warnedPersonaCardReloadFailure = true;
        const reason = err instanceof Error ? err.message : String(err);
        this.onWarn(`人格卡刷新失败（沿用上一轮内容）：${reason}`);
      }
      return;
    }

    if (next === this.personaCardText) return;
    this.personaCardText = next;
    this.rebuildStaticPrompt();
  }

  /**
   * 闲置后，超阈值或攒够 minTurns 才压缩。失败后防抖：在下一个 idleMs
   * 窗口内不再尝试，绝不做「失败立刻重试」（那会反复烧模型调用）。
   */
  private async maybeCompact(): Promise<void> {
    const config = this.compaction;
    if (!config || !config.enabled) return;
    if (!this.memory) return; // 没有记忆层就不压（顺序纪律的第一步做不了）

    const nowMs = this.now();
    if (nowMs - this.lastTurnAt < config.idleMs) return;
    if (this.compactionFailedAt !== null && nowMs - this.compactionFailedAt < config.idleMs) {
      return;
    }

    const minTurns = Math.max(1, Math.floor(config.minTurns ?? 6));
    const hasEnoughTurns = this.turnsSinceCompaction >= minTurns;
    if (estimateTokens(this.history) <= config.thresholdTokens && !hasEnoughTurns) return;

    await this.runCompaction({ force: false });
  }

  /**
   * 唯一的整理实现。force 只由 consolidateNow 使用：跳过自动触发边界，
   * 但仍要求记忆层、非空历史与状态目录。
   */
  private async runCompaction(options: {
    force: boolean;
    signal?: AbortSignal;
  }): Promise<ConsolidationResult> {
    const config = this.compaction;
    if (!config) return { ok: false, reason: '压缩未配置' };
    if (!this.memory) return { ok: false, reason: '记忆层不可用' };
    if (!options.force && !config.enabled) {
      return { ok: false, reason: '自动压缩未启用' };
    }
    if (this.history.length === 0) {
      return { ok: false, reason: '没有可整理的对话历史' };
    }

    const nowMs = this.now();
    const tokensBefore = estimateTokens(this.history);
    const result = await requestCompaction({
      provider: this.provider,
      sessionKey: this.sessionKey,
      staticPrompt: this.systemPrompt,
      history: this.history,
      signal: options.signal,
    });

    if (!result.ok) {
      if (options.signal?.aborted) return { ok: false, reason: '整理已中断' };
      this.compactionFailedAt = nowMs;
      this.onWarn(`压缩放弃：${result.reason}`);
      return { ok: false, reason: result.reason };
    }

    // 顺序纪律：先写记忆，任何一条写失败都放弃本次压缩（不动历史）。
    let memoryOk = true;
    for (const fact of result.payload.facts) {
      const written = this.memory.facts.upsert(this.sessionKey, fact.text, fact.tag as FactTag);
      if (!written) memoryOk = false;
    }
    for (const note of result.payload.selfNotes) {
      const written = this.memory.selfNotes.upsert(this.sessionKey, note);
      if (!written) memoryOk = false;
    }
    if (!memoryOk) {
      this.compactionFailedAt = nowMs;
      this.onWarn('压缩放弃：记忆写入失败（历史保持原样）');
      return { ok: false, reason: '记忆写入失败（历史保持原样）' };
    }

    // 摘要 + 状态先持久化成功，再截断历史，保证重启后不丢。
    const nextHistory = keepRecentTurns(this.history);
    const nextSummary = result.payload.summary;
    const completedAt = this.now();
    // 手动整理成功后也重置闲置锚点，避免保留的 2 轮仍超阈值时下一条消息立刻再整理。
    this.lastTurnAt = completedAt;
    const saved = writeSessionState(config.sessionStateDir, {
      sessionKey: this.sessionKey,
      summary: nextSummary,
      lastActiveAt: new Date(completedAt).toISOString(),
      history: nextHistory
        .filter(
          (message): message is ChatMessage & { role: 'user' | 'assistant' } =>
            message.role === 'user' || message.role === 'assistant',
        )
        .map((message) => ({ role: message.role, content: message.content })),
      turnsSinceCompaction: 0,
      lastTurnAt: new Date(completedAt).toISOString(),
    });
    if (!saved) {
      this.compactionFailedAt = completedAt;
      this.onWarn('压缩放弃：摘要持久化失败（历史保持原样）');
      return { ok: false, reason: '摘要持久化失败（历史保持原样）' };
    }

    this.summary = nextSummary;
    this.history = nextHistory;
    this.turnsSinceCompaction = 0;
    this.compactionFailedAt = null;
    this.rebuildStaticPrompt();

    const tokensAfter = estimateTokens(this.history);
    this.onInfo(
      `压缩完成：${tokensBefore} → ${tokensAfter} tokens（保留最近 2 轮；新增事实 ${result.payload.facts.length} 条、自认知 ${result.payload.selfNotes.length} 条）`,
    );
    return {
      ok: true,
      facts: result.payload.facts.length,
      selfNotes: result.payload.selfNotes.length,
    };
  }

  private trimHistory(): void {
    const maxMessages = this.historyTurns * 2;
    if (this.history.length > maxMessages) {
      this.history = this.history.slice(-maxMessages);
    }
  }

  /** 普通轮次的状态写回：失败只告警一次，绝不阻断聊天。 */
  private persistSessionState(): boolean {
    const config = this.compaction;
    if (!config) return true;

    const nowMs = this.now();
    const saved = writeSessionState(config.sessionStateDir, {
      sessionKey: this.sessionKey,
      summary: this.summary ?? '',
      lastActiveAt: new Date(nowMs).toISOString(),
      history: this.history
        .filter(
          (message): message is ChatMessage & { role: 'user' | 'assistant' } =>
            message.role === 'user' || message.role === 'assistant',
        )
        .map((message) => ({ role: message.role, content: message.content })),
      turnsSinceCompaction: this.turnsSinceCompaction,
      lastTurnAt: new Date(this.lastTurnAt).toISOString(),
    });

    if (!saved && !this.warnedStateWriteFailure) {
      this.warnedStateWriteFailure = true;
      this.onWarn('会话状态写入失败（聊天继续；后续同类错误不再提示）');
    }
    return saved;
  }
}
