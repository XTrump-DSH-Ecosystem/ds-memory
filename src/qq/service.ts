import { join } from 'node:path';
import { Agent } from '../agent/loop.ts';
import { PersonaCardStore } from '../agent/persona-card.ts';
import {
  CodeBridgeClient,
  type CodeBridgeApi,
} from '../code-tasks/bridge-client.ts';
import { CodeTaskManager } from '../code-tasks/manager.ts';
import { CodeTaskStore } from '../code-tasks/store.ts';
import type { AppConfig } from '../config/load.ts';
import { FactsStore } from '../memory/facts.ts';
import { LibraryStore } from '../memory/library.ts';
import { createRetriever } from '../memory/retriever/index.ts';
import type { Retriever } from '../memory/retriever/types.ts';
import { SelfNoteStore } from '../memory/selfnote.ts';
import { EventStore } from '../memory/store.ts';
import { createProvider } from '../provider/index.ts';
import type { Provider } from '../provider/types.ts';
import {
  memoryEventsDir,
  memoryFactsDir,
  memoryLibraryDir,
  memorySelfNotesDir,
  personaCardDir,
  sessionsDir,
} from '../state/paths.ts';
import {
  createAgentWebToolRuntime,
  type AgentWebToolRuntime,
} from '../tools/web/index.ts';
import {
  createAgentMemoryToolRuntime,
} from '../tools/memory/index.ts';
import { createAgentCodeToolRuntime } from '../tools/code/index.ts';
import type { AgentToolRuntime } from '../agent/tool-runtime.ts';
import { info, warn } from '../util/log.ts';
import { redact, redactPaths } from '../util/redact.ts';
import { AgentRegistry } from './agent-registry.ts';
import { wakeAudience } from './audience.ts';
import { batchLimitsFromConfig, type BatchLimits } from './batch.ts';
import { QqClient, type GatewayHealth } from './client.ts';
import { GatewayDiscovery } from './discovery.ts';
import { HookServer, type ReservedHookEvent } from './hooks.ts';
import { SessionInbox } from './inbox.ts';
import { InstanceLock } from './lock.ts';
import { MemberReplyLimiter } from './member-reply-limit.ts';
import { runQqMemoryCommand } from './memory-commands.ts';
import { ReceiptStore } from './receipts.ts';
import { SessionMap, type SessionKind } from './session-map.ts';
import { runQqTurn } from './turn.ts';
import type {
  InboxItem,
  QqSendOptions,
  QqSender,
  QqSenderRole,
  QqTarget,
  RecoveredReceipt,
  SendResult,
  WakePacket,
} from './types.ts';
import { buildWakeBatch } from './wake.ts';
import type { HookEvent } from './wire.ts';

export type GatewayStatus = 'online' | 'offline' | 'unknown';

export interface GatewayClient extends QqSender {
  health?(): Promise<GatewayHealth | null>;
}

export class QqServiceError extends Error {
  readonly code: 'qq_disabled';

  constructor(code: 'qq_disabled', message: string) {
    super(message);
    this.name = 'QqServiceError';
    this.code = code;
  }
}

export interface QqServiceOptions {
  config: AppConfig;
  persona: string;
  instanceId?: string;
  provider?: Provider;
  senderFactory?: (baseUrl: string) => GatewayClient;
  discovery?: Pick<GatewayDiscovery, 'resolve'>;
  lock?: InstanceLock;
  store?: EventStore;
  receipts?: ReceiptStore;
  sessionMap?: SessionMap;
  facts?: FactsStore;
  selfNotes?: SelfNoteStore;
  personaCard?: PersonaCardStore;
  library?: LibraryStore;
  retriever?: Retriever;
  inbox?: SessionInbox;
  now?: () => number;
  onWarn?: (message: string) => void;
  onInfo?: (message: string) => void;
  /** 覆盖 qq.healthIntervalMs（测试用）。 */
  healthIntervalMs?: number;
  /** 测试注入；缺省按 codeBridge.enabled 创建。 */
  codeTaskManager?: CodeTaskManager;
  /** 测试注入 code-bridge transport；不启动真实 bridge。 */
  codeBridgeClient?: CodeBridgeApi;
}

export interface QqService {
  readonly port: number;
  readonly lock: InstanceLock;
  readonly receipts: ReceiptStore;
  readonly sessionMap: SessionMap;
  readonly inbox: SessionInbox;
  readonly registry: AgentRegistry;
  readonly recoveredCount: number;
  readonly abortedCount: number;
  readonly gatewayStatus: GatewayStatus;
  readonly codeTaskManager: CodeTaskManager | null;
  stop(): Promise<void>;
  waitForIdle(timeoutMs?: number): Promise<void>;
}

interface QqServiceDependencies {
  store: EventStore;
  facts: FactsStore;
  selfNotes: SelfNoteStore;
  personaCard: PersonaCardStore;
  library: LibraryStore;
  retriever: Retriever;
  provider: Provider;
  receipts: ReceiptStore;
  sessionMap: SessionMap;
  inbox: SessionInbox;
  registry: AgentRegistry;
  discovery: Pick<GatewayDiscovery, 'resolve'>;
}

interface ParsedSessionKey {
  kind: SessionKind;
  id: string;
}

function parseSessionKey(sessionKey: string): ParsedSessionKey | null {
  const privatePrefix = 'private:';
  const groupPrefix = 'group:';
  if (sessionKey.startsWith(privatePrefix)) {
    const id = sessionKey.slice(privatePrefix.length);
    return id.length > 0 ? { kind: 'private', id } : null;
  }
  if (sessionKey.startsWith(groupPrefix)) {
    const id = sessionKey.slice(groupPrefix.length);
    return id.length > 0 ? { kind: 'group', id } : null;
  }
  return null;
}

function targetOf(sessionKey: string): QqTarget | null {
  const parsed = parseSessionKey(sessionKey);
  return parsed ? { kind: parsed.kind, id: parsed.id } : null;
}

function senderRoleOf(
  kind: SessionKind,
  senderQQ: string | null | undefined,
  ownerQQ: number,
): QqSenderRole {
  if (kind === 'private') return 'owner';
  return senderQQ !== null && senderQQ !== undefined && senderQQ === String(ownerQQ)
    ? 'owner'
    : 'member';
}

function allIndexes(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index);
}

class QqServiceRuntime implements QqService {
  private readonly options: QqServiceOptions;
  private readonly config: AppConfig;
  private readonly now: () => number;
  private readonly safeWarn: (message: string) => void;
  private readonly safeInfo: (message: string) => void;
  private readonly windowMs: number;
  private readonly limits: BatchLimits;
  private readonly memberReplyLimiter: MemberReplyLimiter;
  private readonly abort = new AbortController();

  private lockInstance: InstanceLock | null = null;
  private deps: QqServiceDependencies | null = null;
  private hook: HookServer | null = null;

  private stopping = false;
  private stopPromise: Promise<void> | null = null;
  private startedAt = 0;
  private recovered = 0;
  private aborted = 0;
  private gateway: GatewayStatus = 'unknown';

  private readonly windowTimers = new Map<string, NodeJS.Timeout>();
  private readonly queuedSince = new Map<string, number>();
  private readonly inFlight = new Set<Promise<void>>();
  private readonly clients = new Map<string, GatewayClient>();
  private healthTimer: NodeJS.Timeout | null = null;
  private healthInFlight: Promise<void> | null = null;
  private codeTasks: CodeTaskManager | null = null;

  private readonly sender: QqSender = {
    send: (target, messages, opts) => this.sendViaGateway(target, messages, opts),
  };

  constructor(options: QqServiceOptions) {
    this.options = options;
    this.config = options.config;
    this.now = options.now ?? Date.now;
    this.windowMs = this.config.qq.batchWindowMs;
    this.limits = batchLimitsFromConfig(this.config.qq);

    const targetWarn = options.onWarn ?? ((message: string) => warn(message));
    const targetInfo = options.onInfo ?? ((message: string) => info(message));
    this.safeWarn = (message) => targetWarn(redactPaths(redact(message)));
    this.safeInfo = (message) => targetInfo(redactPaths(redact(message)));
    this.memberReplyLimiter = new MemberReplyLimiter({
      minIntervalMs: this.config.qq.groupMemberReply.minIntervalMs,
      maxPerMinute: this.config.qq.groupMemberReply.maxPerMinute,
      now: this.now,
    });
  }

  get port(): number {
    return this.hook?.port ?? 0;
  }

  get lock(): InstanceLock {
    if (!this.lockInstance) throw new Error('QQ service 尚未启动');
    return this.lockInstance;
  }

  get receipts(): ReceiptStore {
    return this.requireDeps().receipts;
  }

  get sessionMap(): SessionMap {
    return this.requireDeps().sessionMap;
  }

  get inbox(): SessionInbox {
    return this.requireDeps().inbox;
  }

  get registry(): AgentRegistry {
    return this.requireDeps().registry;
  }

  get recoveredCount(): number {
    return this.recovered;
  }

  get abortedCount(): number {
    return this.aborted;
  }

  get gatewayStatus(): GatewayStatus {
    return this.gateway;
  }

  get codeTaskManager(): CodeTaskManager | null {
    return this.codeTasks;
  }

  async start(): Promise<void> {
    if (this.deps) return;
    if (!this.config.qq.enabled) {
      throw new QqServiceError('qq_disabled', 'QQ 服务未启用');
    }

    this.startedAt = this.now();
    this.lockInstance =
      this.options.lock ??
      new InstanceLock({
        stateDir: this.config.stateDir,
        runtimeDir: this.config.qq.runtimeDir,
        instanceId: this.options.instanceId,
        now: this.now,
      });
    this.lockInstance.acquire();

    const deps = this.buildDependencies();
    this.deps = deps;
    this.codeTasks =
      this.options.codeTaskManager ?? this.createCodeTaskManager();

    const boot = deps.receipts.bootstrapFromL0();
    this.recovered = boot.recovered.length;
    this.aborted = boot.aborted.length;
    this.routeRecovered(boot.recovered);

    const hook = new HookServer({
      port: this.config.qq.hookPort,
      token: this.config.qq.hookToken,
      runtimeDir: this.config.qq.runtimeDir,
      receipts: deps.receipts,
      sessionMap: deps.sessionMap,
      now: this.now,
      onWarn: this.safeWarn,
      instanceId: this.lockInstance.instanceId,
      onReserved: (reserved) => this.handleReserved(reserved),
      onCodeCommand: this.codeTasks
        ? (event) => this.handleCodeCommand(event)
        : undefined,
      statusProvider: () => this.statusSnapshot(),
    });
    this.hook = hook;

    this.codeTasks?.start();
    await hook.start();

    for (const sessionKey of deps.inbox.pendingSessions()) {
      this.queuedSince.set(sessionKey, this.now());
      this.armWindow(sessionKey);
    }
    this.startHealthLoop();
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;

    for (const timer of this.windowTimers.values()) clearTimeout(timer);
    this.windowTimers.clear();
    this.queuedSince.clear();
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
    this.abort.abort();
    const codeTasksStop = this.codeTasks?.stop();

    this.stopPromise = (async () => {
      const pending: Promise<unknown>[] = [...this.inFlight];
      if (this.healthInFlight) pending.push(this.healthInFlight);
      await Promise.allSettled(pending);
      if (codeTasksStop) {
        try {
          await codeTasksStop;
        } catch {
          this.safeWarn('code 任务轮询停止失败');
        }
      }
      if (this.hook) {
        try {
          await this.hook.stop();
        } catch {
          this.safeWarn('hook 停止失败');
        }
      }
      this.lockInstance?.release();
    })();
    return this.stopPromise;
  }

  async waitForIdle(timeoutMs: number = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.stopping) return;
      const deps = this.deps;
      const pending = deps
        ? deps.inbox
            .pendingSessions()
            .reduce((total, sessionKey) => total + deps.inbox.size(sessionKey), 0)
        : 0;
      if (
        this.windowTimers.size === 0 &&
        this.inFlight.size === 0 &&
        pending === 0 &&
        (deps?.inbox.busySessionsSnapshot().length ?? 0) === 0
      ) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('等待 QQ service 空闲超时');
  }

  private requireDeps(): QqServiceDependencies {
    if (!this.deps) throw new Error('QQ service 尚未启动');
    return this.deps;
  }

  private buildDependencies(): QqServiceDependencies {
    const qq = this.config.qq;
    const store =
      this.options.store ??
      new EventStore({
        dir: memoryEventsDir(this.config.stateDir),
        now: this.now,
        onWarn: this.safeWarn,
      });
    const facts =
      this.options.facts ??
      new FactsStore({
        dir: memoryFactsDir(this.config.stateDir),
        halfLifeDays: this.config.memory.facts.halfLifeDays,
        archiveThreshold: this.config.memory.facts.archiveThreshold,
        injectMax: this.config.memory.facts.injectMax,
        injectMaxChars: this.config.memory.facts.injectMaxChars,
        autoReviewEnabled: this.config.memory.facts.autoReview,
        onWarn: this.safeWarn,
      });
    const selfNotes =
      this.options.selfNotes ??
      new SelfNoteStore({
        dir: memorySelfNotesDir(this.config.stateDir),
        max: this.config.memory.selfNote.max,
        bootstrapLimit: this.config.memory.selfNote.bootstrapLimit,
        onWarn: this.safeWarn,
      });
    const personaCard =
      this.options.personaCard ??
      new PersonaCardStore({
        dir: personaCardDir(this.config.stateDir),
        onWarn: this.safeWarn,
      });
    const library =
      this.options.library ??
      new LibraryStore({
        dir: memoryLibraryDir(this.config.stateDir),
        now: this.now,
        onWarn: this.safeWarn,
      });
    const retriever =
      this.options.retriever ??
      createRetriever({
        store,
        ownerQQ: qq.ownerQQ,
        now: this.now,
        recall: this.config.memory.recall,
        onWarn: this.safeWarn,
        onInfo: this.safeInfo,
      });
    const sessionMap =
      this.options.sessionMap ??
      new SessionMap({
        stateDir: this.config.stateDir,
        ownerQQ: qq.ownerQQ,
        allowGroups: qq.allowGroups,
        denyPrivate: qq.denyPrivate,
        denyGroups: qq.denyGroups,
        allowGroupMemberReply: qq.groupMemberReply.enabled,
        groupWake: qq.groupWake,
        now: this.now,
        onWarn: this.safeWarn,
      });
    const receipts =
      this.options.receipts ??
      new ReceiptStore({
        dir: join(this.config.stateDir, 'qq'),
        store,
        dedupeTtlMs: qq.dedupeTtlMs,
        now: this.now,
        onWarn: this.safeWarn,
      });
    const provider = this.options.provider ?? createProvider(this.config.provider);
    const inbox = this.options.inbox ?? new SessionInbox();
    const registry = new AgentRegistry({
      createAgent: (sessionKey) =>
        new Agent({
          provider,
          store,
          persona: this.options.persona,
          personaCard: personaCard.promptText(),
          reloadPersonaCard: () => personaCard.promptText(),
          sessionKey,
          src: 'qq',
          now: this.now,
          memory: {
            facts,
            selfNotes,
            retriever,
            recall: this.config.memory.recall,
          },
          compaction: {
            enabled: this.config.agent.compaction.enabled,
            idleMs: this.config.agent.compaction.idleMs,
            thresholdTokens: this.config.agent.compaction.thresholdTokens,
            minTurns: this.config.agent.compaction.minTurns,
            sessionStateDir: sessionsDir(this.config.stateDir),
          },
          onWarn: this.safeWarn,
          onInfo: this.safeInfo,
        }),
    });
    const discovery =
      this.options.discovery ??
      new GatewayDiscovery({
        gatewayUrl: qq.gatewayUrl,
        runtimeDir: qq.runtimeDir,
      });

    return {
      store,
      facts,
      selfNotes,
      personaCard,
      library,
      retriever,
      provider,
      receipts,
      sessionMap,
      inbox,
      registry,
      discovery,
    };
  }

  private createCodeTaskManager(): CodeTaskManager | null {
    const config = this.config.codeBridge;
    if (!config.enabled && !this.options.codeBridgeClient) return null;

    const bridge =
      this.options.codeBridgeClient ??
      new CodeBridgeClient({
        endpointFile: config.endpointFile,
        tokenFile: config.tokenFile,
        timeoutMs: config.requestTimeoutMs,
      });
    return new CodeTaskManager({
      ownerQQ: this.config.qq.ownerQQ,
      allowGroups: this.config.qq.allowGroups.filter(
        (groupId) => !this.config.qq.denyGroups.includes(groupId),
      ),
      store: new CodeTaskStore({
        stateDir: this.config.stateDir,
        onWarn: this.safeWarn,
      }),
      bridge,
      sender: this.sender,
      pollIntervalMs: config.pollIntervalMs,
      summaryMaxChars: config.summaryMaxChars,
      now: this.now,
      onWarn: this.safeWarn,
    });
  }

  private handleCodeCommand(event: HookEvent): void {
    const manager = this.codeTasks;
    if (!manager || this.stopping) return;
    if (!this.isCodeCommandAllowed(event)) return;

    void manager
      .handleIncoming({
        requestId: event.eventId,
        text: event.text,
        source: { kind: event.source.kind, id: event.source.id },
        senderQQ: event.sender.qqId,
        isAtBot: event.isAtBot,
      })
      .then(async (messages) => {
        if (this.stopping || messages.length === 0) return;
        try {
          await this.sender.send(
            { kind: event.source.kind, id: event.source.id },
            messages,
            { reason: 'reply' },
          );
        } catch {
          this.safeWarn('code 命令回执发送失败');
        }
      })
      .catch(() => {
        this.safeWarn('code 命令处理失败');
      });
  }

  /**
   * code 控制面权限：owner 私聊，或白名单群内 owner 显式 @/引用。
   * denyGroups 优先；普通群友、陌生私聊、非 @ 群消息一律静默丢弃。
   */
  private isCodeCommandAllowed(event: HookEvent): boolean {
    const ownerQQ = this.config.qq.ownerQQ;
    if (ownerQQ <= 0) return false;
    const ownerId = String(ownerQQ);
    if (event.sender.qqId !== ownerId) return false;

    if (event.source.kind === 'private') {
      return event.source.id === ownerId;
    }

    if (!/^\d+$/.test(event.source.id)) return false;
    const groupId = Number(event.source.id);
    if (!Number.isSafeInteger(groupId) || String(groupId) !== event.source.id) {
      return false;
    }
    if (event.isAtBot !== true) return false;
    return (
      this.config.qq.allowGroups.includes(groupId) &&
      !this.config.qq.denyGroups.includes(groupId)
    );
  }

  private routeRecovered(recovered: readonly RecoveredReceipt[]): void {
    const deps = this.requireDeps();

    for (const entry of recovered) {
      const item = this.recoveredItem(entry);
      if (!item) {
        this.markStoredOnly(entry.receipt.eventId);
        continue;
      }
      deps.inbox.enqueue(item);
    }
  }

  private recoveredItem(entry: RecoveredReceipt): InboxItem | null {
    const record = entry.record;
    const parsed = parseSessionKey(record.sessionKey);
    if (!parsed) return null;

    const senderQQ =
      record.senderQqId ?? (parsed.kind === 'private' ? parsed.id : undefined);
    const decision = this.requireDeps().sessionMap.classify({
      kind: parsed.kind,
      id: parsed.id,
    }, senderQQ, { isAtBot: record.isAtBot === true });
    if (decision.action !== 'allow' || decision.sessionKey !== record.sessionKey) {
      return null;
    }
    const legacyPrivateOwner =
      parsed.kind === 'private' && parsed.id === String(this.config.qq.ownerQQ);
    if (record.modelEligible === false) return null;
    if (record.modelEligible !== true && !legacyPrivateOwner) return null;
    if (!decision.modelEligible) {
      return null;
    }

    this.ensureSessionRecorded(record.sessionKey, parsed, Date.parse(record.t), senderQQ);

    const isAtBot = record.isAtBot === true;
    if (parsed.kind === 'group' && this.config.qq.groupWake === 'mention' && !isAtBot) {
      return null;
    }

    return {
      eventId: record.id,
      sessionKey: record.sessionKey,
      kind: parsed.kind,
      speaker: parsed.kind === 'group' ? (record.speaker ?? null) : null,
      senderRole: senderRoleOf(parsed.kind, senderQQ, this.config.qq.ownerQQ),
      origin: 'recovered',
      senderQqId: record.senderQqId ?? undefined,
      text: record.text,
      quote: record.quote ?? null,
      isAtBot,
      receivedAt: Date.parse(record.t),
    };
  }

  private ensureSessionRecorded(
    sessionKey: string,
    parsed: ParsedSessionKey,
    at: number,
    senderQQ?: string | null,
  ): void {
    const map = this.requireDeps().sessionMap;
    if (map.get(sessionKey)) return;
    map.record({ kind: parsed.kind, id: parsed.id }, at, senderQQ);
  }

  private handleReserved(reserved: ReservedHookEvent): void {
    if (this.stopping) return;
    const deps = this.deps;
    if (!deps) return;
    if (reserved.receipt.status !== 'received') return;

    const event = reserved.event;
    const item: InboxItem = {
      eventId: reserved.receipt.eventId,
      sessionKey: reserved.sessionKey,
      kind: event.source.kind,
      speaker: event.source.kind === 'group' ? event.sender.nickname : null,
      senderRole: senderRoleOf(event.source.kind, event.sender.qqId, this.config.qq.ownerQQ),
      origin: 'live',
      senderQqId: event.sender.qqId,
      text: event.text,
      quote: event.quote,
      isAtBot: event.isAtBot,
      receivedAt: event.at,
    };

    deps.inbox.enqueue(item);
    if (this.windowTimers.has(item.sessionKey)) return;

    if (!this.queuedSince.has(item.sessionKey)) {
      this.queuedSince.set(item.sessionKey, this.now());
    }
    if (!deps.inbox.isBusy(item.sessionKey)) {
      this.armWindow(item.sessionKey);
    }
  }

  /** 首批入队起算窗口；已有窗口或忙时不重置。 */
  private armWindow(sessionKey: string): void {
    if (this.stopping || !this.deps) return;
    if (this.windowTimers.has(sessionKey)) return;
    if (this.deps.inbox.isBusy(sessionKey)) return;
    this.armTimer(sessionKey, this.windowMs);
  }

  private armTimer(sessionKey: string, delayMs: number): void {
    if (this.stopping) return;
    const existing = this.windowTimers.get(sessionKey);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.windowTimers.delete(sessionKey);
      this.runScheduled(sessionKey);
    }, delayMs);
    this.windowTimers.set(sessionKey, timer);
  }

  private runScheduled(sessionKey: string): void {
    if (this.stopping || !this.deps) return;
    const batch = this.deps.inbox.takeNextBatch(sessionKey);
    this.queuedSince.delete(sessionKey);
    if (!batch) return;

    const operation = this.processBatch(sessionKey, batch)
      .catch(() => {
        this.safeWarn('QQ 批处理失败');
      })
      .finally(() => {
        this.inFlight.delete(operation);
      });
    this.inFlight.add(operation);
  }

  private async processBatch(sessionKey: string, batch: InboxItem[]): Promise<void> {
    const deps = this.requireDeps();
    if (this.stopping) {
      deps.inbox.requeueFront(sessionKey, batch);
      deps.inbox.release(sessionKey);
      return;
    }

    // 记忆权限仍只看原始批次的 live owner 身份。
    const memoryToolsAllowed = this.isMemoryToolsAllowed(sessionKey, batch);
    const codeToolsAllowed = this.isCodeToolsAllowed(sessionKey, batch);
    const codeEventId = batch.at(-1)?.eventId;

    let wake;
    try {
      wake = buildWakeBatch(batch, {
        groupWake: this.config.qq.groupWake,
        limits: this.limits,
      });
    } catch {
      deps.inbox.requeueFront(sessionKey, batch);
      this.releaseAndContinue(sessionKey);
      return;
    }

    for (const item of wake.storedOnly) {
      this.markStoredOnly(item.eventId);
    }

    if (!wake.packet) {
      if (wake.omitted.length > 0) {
        deps.inbox.requeueFront(sessionKey, wake.omitted);
      }
      this.releaseAndContinue(sessionKey);
      return;
    }

    const target = targetOf(sessionKey);
    if (!target) {
      for (const item of wake.packet.items) {
        this.markFailed(item.eventId, 'invalid_session');
      }
      if (wake.omitted.length > 0) {
        deps.inbox.requeueFront(sessionKey, wake.omitted);
      }
      this.releaseAndContinue(sessionKey);
      return;
    }

    const audience = wakeAudience(wake.packet);
    if (
      audience === 'member' &&
      !this.memberReplyLimiter.canStart(sessionKey, this.now())
    ) {
      for (const item of wake.packet.items) {
        this.markStoredOnly(item.eventId);
      }
      this.safeInfo('普通群成员回复触发限流，本批转为 stored_only');
      if (wake.omitted.length > 0) {
        deps.inbox.requeueFront(sessionKey, wake.omitted);
      }
      this.releaseAndContinue(sessionKey);
      return;
    }

    // 联网权限按实际进包的条目判定；只写 L0 的成员消息不能误伤 owner 回合。
    const webToolsAllowed = this.isWebToolsAllowed(sessionKey, batch, wake.packet);

    try {
      const webTools = webToolsAllowed
        ? this.createWebTools(sessionKey)
        : undefined;
      const memoryTools = memoryToolsAllowed
        ? this.createMemoryTools(sessionKey)
        : undefined;
      const codeTools =
        codeToolsAllowed && codeEventId !== undefined
          ? this.createCodeTools(sessionKey, codeEventId)
          : undefined;
      await runQqTurn({
        registry: deps.registry,
        sessionKey,
        wake: wake.packet,
        sender: this.sender,
        receipts: deps.receipts,
        target,
        maxPerTurn: this.config.qq.send.maxPerTurn,
        signal: this.abort.signal,
        webToolsAllowed,
        webTools: webTools ?? undefined,
        memoryToolsAllowed,
        memoryTools: memoryTools ?? undefined,
        codeToolsAllowed,
        codeTools: codeTools ?? undefined,
        memberReplyGate: audience === 'member' ? this.memberReplyLimiter : undefined,
        commands: (text, agent) =>
          runQqMemoryCommand(text, {
            sessionKey,
            facts: deps.facts,
            selfNotes: deps.selfNotes,
            retriever: deps.retriever,
            recallBudgetItems: this.config.memory.recall.budgetItems,
            personaCard: deps.personaCard,
            onPersonaCardChanged: () => agent.refreshPersonaCard(),
            consolidate: () => agent.consolidateNow(),
          }),
      });
    } catch {
      this.safeWarn('QQ 回合失败');
      for (const item of wake.packet.items) {
        this.markFailed(item.eventId, 'turn_failed');
      }
    } finally {
      if (wake.omitted.length > 0) {
        deps.inbox.requeueFront(sessionKey, wake.omitted);
      }
      this.releaseAndContinue(sessionKey);
    }
  }

  /**
   * 联网工具判定基于实际进入模型的 wake.packet 条目，按 eventId 回查原始
   * InboxItem（isAtBot 不进 WakeItem）。私聊沿用 live owner 语义；群聊必须是
   * allowGroups 内的 live owner 消息，且至少一条 @/引用机器人。任何成员、
   * recovered、缺字段、伪造 sender 或混杂条目一律 fail-closed。
   */
  private isWebToolsAllowed(
    sessionKey: string,
    batch: readonly InboxItem[],
    packet: WakePacket,
  ): boolean {
    const ownerQQ = this.config.qq.ownerQQ;
    if (ownerQQ <= 0) return false;
    if (this.config.webSearch.enabled !== true) return false;
    if (this.requireDeps().provider.supportsTools !== true) return false;
    if (packet.items.length === 0) return false;

    const rawById = new Map<string, InboxItem>();
    for (const item of batch) {
      if (rawById.has(item.eventId)) return false;
      rawById.set(item.eventId, item);
    }

    const included: InboxItem[] = [];
    for (const wakeItem of packet.items) {
      const raw = rawById.get(wakeItem.eventId);
      if (!raw || raw.sessionKey !== sessionKey) return false;
      included.push(raw);
    }

    const parsed = parseSessionKey(sessionKey);
    if (!parsed) return false;

    const isOwnerSender = (item: InboxItem): boolean =>
      typeof item.senderQqId === 'string' && item.senderQqId === String(ownerQQ);

    if (parsed.kind === 'private') {
      if (sessionKey !== `private:${ownerQQ}`) return false;
      return included.every(
        (item) => item.kind === 'private' && item.origin === 'live' && isOwnerSender(item),
      );
    }

    if (!/^\d+$/.test(parsed.id)) return false;
    const groupId = Number(parsed.id);
    if (!Number.isSafeInteger(groupId) || String(groupId) !== parsed.id) return false;
    if (!this.config.qq.allowGroups.includes(groupId)) return false;

    const allOwner = included.every(
      (item) =>
        item.kind === 'group' &&
        item.origin === 'live' &&
        item.senderRole === 'owner' &&
        isOwnerSender(item),
    );
    if (!allOwner) return false;
    return included.some((item) => item.isAtBot === true);
  }

  /** 运行时不可用只告警并按无工具处理，不影响正常文本回复。 */
  private createWebTools(sessionKey: string): AgentWebToolRuntime | null {
    try {
      return createAgentWebToolRuntime({
        ownerSessionKey: sessionKey,
        endpointFile: this.config.webSearch.endpointFile,
        engines: this.config.webSearch.engines,
        deepseek: this.config.webSearch.deepseek,
        onPrimaryFailure: (code) => {
          this.safeWarn(`联网主源失败，回退 open-websearch：${code}`);
        },
        logger: (event) => {
          const code = event.code ? ` ${event.code}` : '';
          this.safeInfo(
            `联网工具 ${event.event} ${event.outcome}${code} ${event.durationMs}ms`,
          );
        },
      });
    } catch {
      this.safeWarn('联网工具初始化失败，本批按无工具处理');
      return null;
    }
  }

  /**
   * 记忆写入权限：仅 live owner 私聊，且 Provider 支持工具。
   * 不依赖 webSearch.enabled；群聊/recovered/伪造成员一律 fail-closed。
   */
  private isMemoryToolsAllowed(sessionKey: string, batch: InboxItem[]): boolean {
    const ownerQQ = this.config.qq.ownerQQ;
    if (ownerQQ <= 0) return false;
    if (sessionKey !== `private:${ownerQQ}`) return false;
    if (
      batch.length === 0 ||
      !batch.every(
        (item) =>
          item.kind === 'private' &&
          item.origin === 'live' &&
          item.senderRole === 'owner' &&
          typeof item.senderQqId === 'string' &&
          item.senderQqId === String(ownerQQ),
      )
    ) {
      return false;
    }
    return this.requireDeps().provider.supportsTools === true;
  }

  /** 记忆工具构造失败时按无工具处理，不影响正常文本回复。 */
  private createMemoryTools(sessionKey: string): AgentToolRuntime | null {
    try {
      const deps = this.requireDeps();
      return createAgentMemoryToolRuntime({
        ownerSessionKey: sessionKey,
        facts: deps.facts,
        selfNotes: deps.selfNotes,
        library: deps.library,
      });
    } catch {
      this.safeWarn('记忆工具初始化失败，本批按无工具处理');
      return null;
    }
  }

  /**
   * 代码工具权限：仅 live owner 私聊、Provider 支持工具，且 codeBridge 启用。
   * 群聊、recovered、伪造 sender、混批一律 fail-closed。
   */
  private isCodeToolsAllowed(
    sessionKey: string,
    batch: InboxItem[],
  ): boolean {
    const ownerQQ = this.config.qq.ownerQQ;
    if (ownerQQ <= 0) return false;
    if (this.config.codeBridge.enabled !== true) return false;
    if (!this.codeTasks) return false;
    if (sessionKey !== `private:${ownerQQ}`) return false;
    if (
      batch.length === 0 ||
      !batch.every(
        (item) =>
          item.kind === 'private' &&
          item.origin === 'live' &&
          item.senderRole === 'owner' &&
          typeof item.senderQqId === 'string' &&
          item.senderQqId === String(ownerQQ),
      )
    ) {
      return false;
    }
    return this.requireDeps().provider.supportsTools === true;
  }

  /** 代码工具构造失败时按无工具处理，不影响正常文本回复。 */
  private createCodeTools(
    sessionKey: string,
    eventId: string,
  ): AgentToolRuntime | null {
    const manager = this.codeTasks;
    if (!manager) return null;
    try {
      return createAgentCodeToolRuntime({
        ownerQQ: this.config.qq.ownerQQ,
        ownerSessionKey: sessionKey,
        eventId,
        manager,
      });
    } catch {
      this.safeWarn('代码工具初始化失败，本批按无工具处理');
      return null;
    }
  }

  private releaseAndContinue(sessionKey: string): void {
    const deps = this.deps;
    if (!deps) return;
    deps.inbox.release(sessionKey);
    if (!this.stopping && deps.inbox.size(sessionKey) > 0) {
      const since = this.queuedSince.get(sessionKey);
      const delay =
        since === undefined
          ? 0
          : Math.max(0, since + this.windowMs - this.now());
      this.armTimer(sessionKey, delay);
    }
  }

  private markStoredOnly(eventId: string): void {
    try {
      if (!this.requireDeps().receipts.markStoredOnly(eventId)) {
        this.safeWarn('Receipt stored_only 状态迁移失败');
      }
    } catch {
      this.safeWarn('Receipt stored_only 状态迁移失败');
    }
  }

  private markFailed(eventId: string, reason: string): void {
    try {
      this.requireDeps().receipts.markFailed(eventId, reason);
    } catch {
      this.safeWarn('Receipt failed 状态迁移失败');
    }
  }

  private async sendViaGateway(
    target: QqTarget,
    messages: string[],
    opts: QqSendOptions = {},
  ): Promise<SendResult> {
    const resolution = this.requireDeps().discovery.resolve();
    if (resolution.kind === 'offline') {
      return {
        outcome: 'none_sent',
        sentIndexes: [],
        failedIndexes: allIndexes(messages.length),
        retryable: false,
        retryAfterMs: null,
        reason: 'gateway_offline',
      };
    }

    try {
      return await this.clientFor(resolution.baseUrl).send(target, messages, opts);
    } catch {
      this.safeWarn('网关发送失败');
      return {
        outcome: 'ambiguous_failure',
        sentIndexes: [],
        failedIndexes: [],
        retryable: false,
        retryAfterMs: null,
        reason: 'sender_exception',
      };
    }
  }

  private clientFor(baseUrl: string): GatewayClient {
    const existing = this.clients.get(baseUrl);
    if (existing) return existing;

    const created =
      this.options.senderFactory?.(baseUrl) ??
      new QqClient({
        baseUrl,
        token: this.config.qq.hookToken,
        sendTimeoutMs: this.config.qq.send.sendTimeoutMs,
        retryDelaysMs: this.config.qq.send.retryDelaysMs,
        onWarn: this.safeWarn,
      });
    this.clients.set(baseUrl, created);
    return created;
  }

  private startHealthLoop(): void {
    const interval = this.options.healthIntervalMs ?? this.config.qq.healthIntervalMs;
    this.healthTimer = setInterval(() => {
      void this.checkHealth();
    }, interval);
    this.healthTimer.unref?.();
    void this.checkHealth();
  }

  private checkHealth(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.healthInFlight) return this.healthInFlight;

    let operation: Promise<void>;
    operation = this.performHealth()
      .catch(() => {
        if (!this.stopping) this.gateway = 'offline';
        this.safeWarn('网关健康检查失败');
      })
      .finally(() => {
        if (this.healthInFlight === operation) this.healthInFlight = null;
      });
    this.healthInFlight = operation;
    return operation;
  }

  private async performHealth(): Promise<void> {
    const resolution = this.requireDeps().discovery.resolve();
    if (resolution.kind === 'offline') {
      if (!this.stopping) this.gateway = 'offline';
      return;
    }

    const client = this.clientFor(resolution.baseUrl);
    if (!client.health) return;
    const health = await client.health();
    if (this.stopping) return;
    this.gateway = health?.online === true ? 'online' : 'offline';
  }

  private statusSnapshot(): Record<string, unknown> {
    const deps = this.deps;
    const inbox = deps?.inbox;
    const pending = inbox
      ? inbox
          .pendingSessions()
          .reduce((total, sessionKey) => total + inbox.size(sessionKey), 0)
      : 0;

    return {
      pid: process.pid,
      uptimeMs: Math.max(0, this.now() - this.startedAt),
      hookPort: this.hook?.port ?? 0,
      gateway: this.gateway,
      sessions: deps?.sessionMap.count ?? 0,
      receipts: deps?.receipts.count ?? 0,
      inbox: {
        pending,
        busy: inbox?.busySessionsSnapshot().length ?? 0,
      },
      recovered: this.recovered,
      aborted: this.aborted,
    };
  }
}

export async function startQqService(options: QqServiceOptions): Promise<QqService> {
  const runtime = new QqServiceRuntime(options);
  try {
    await runtime.start();
    return runtime;
  } catch (err) {
    await runtime.stop();
    throw err;
  }
}
