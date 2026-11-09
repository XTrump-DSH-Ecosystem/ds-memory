import type { Agent, RunTurnOptions } from '../agent/loop.ts';
import type { AgentToolRuntime } from '../agent/tool-runtime.ts';
import type { AgentWebToolRuntime } from '../tools/web/index.ts';
import type { AgentRegistry } from './agent-registry.ts';
import { isOwnerWakeItem, wakeAudience } from './audience.ts';
import type { MemberReplyGate } from './member-reply-limit.ts';
import type { QqMemoryCommandResult } from './memory-commands.ts';
import { buildReplyPlan } from './reply.ts';
import type {
  QqSender,
  QqTarget,
  ReceiptStore,
  ReplyPlan,
  SendResult,
  WakePacket,
} from './types.ts';

/** runQqTurn 只依赖 ReceiptStore 的三个状态迁移入口，便于测试注入。 */
export type QqTurnReceipts = Pick<
  ReceiptStore,
  'markProcessing' | 'markDone' | 'markFailed'
>;

export interface RunQqTurnOptions {
  registry: Pick<AgentRegistry, 'runExclusive'>;
  sessionKey: string;
  wake: WakePacket;
  sender: QqSender;
  receipts: QqTurnReceipts;
  target: QqTarget;
  /** 0 = 静音；正数不再作为回复截断上限。 */
  maxPerTurn: number;
  signal: AbortSignal;
  /** 权限层判定；只有 true 且 webTools 存在时才把 runtime 交给 Agent。 */
  webToolsAllowed?: boolean;
  /** owner-only 联网 runtime；缺失按无工具处理。 */
  webTools?: AgentWebToolRuntime;
  /** owner-only 记忆 runtime；缺失按无工具处理。 */
  memoryToolsAllowed?: boolean;
  memoryTools?: AgentToolRuntime;
  /** owner-only 代码任务 runtime；缺失按无工具处理。 */
  codeToolsAllowed?: boolean;
  codeTools?: AgentToolRuntime;
  /** owner-only 记忆命令；不传时所有消息都走模型。 */
  commands?: (text: string, agent: Agent) => Promise<QqMemoryCommandResult>;
  /** 普通群成员回复节流；owner 回合不传。 */
  memberReplyGate?: MemberReplyGate;
}

export interface QqTurnResult {
  plan: ReplyPlan;
  /** 空回复计划未调用发送时为 null。 */
  sendResult: SendResult | null;
  /** 实际送达的 messages 按原序以换行拼接；零送达时为空串。 */
  deliveredText: string;
}

const DELIVERY_SEPARATOR = '\n';

function emptyTurnResult(): QqTurnResult {
  return { plan: { messages: [] }, sendResult: null, deliveredText: '' };
}

function rateLimitedSendResult(messageCount: number): SendResult {
  return {
    outcome: 'none_sent',
    sentIndexes: [],
    failedIndexes: Array.from({ length: messageCount }, (_, index) => index),
    retryable: false,
    retryAfterMs: null,
    reason: 'rate_limited',
  };
}

function markFailedAll(
  receipts: QqTurnReceipts,
  eventIds: readonly string[],
  reason: string,
): unknown | null {
  let firstError: unknown = null;
  for (const eventId of eventIds) {
    try {
      receipts.markFailed(eventId, reason);
    } catch (error) {
      // 尽量把其余事件也标记为失败；由调用方决定是否覆盖原始错误。
      firstError ??= error;
    }
  }
  return firstError;
}

function markDoneAll(
  receipts: QqTurnReceipts,
  eventIds: readonly string[],
  sentIndexes: readonly number[],
  failedIndexes: readonly number[],
): void {
  let firstError: unknown = null;
  for (const eventId of eventIds) {
    try {
      receipts.markDone(eventId, [...sentIndexes], [...failedIndexes]);
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError !== null) throw firstError;
}

/** 按 messages 原序交付；忽略越界/重复 index，不依赖 sentIndexes 的顺序。 */
function orderedDeliveredIndexes(
  sentIndexes: readonly number[],
  messageCount: number,
): number[] {
  const seen = new Set<number>();
  const indexes: number[] = [];
  for (const index of sentIndexes) {
    if (!Number.isInteger(index) || index < 0 || index >= messageCount) continue;
    if (seen.has(index)) continue;
    seen.add(index);
    indexes.push(index);
  }
  return indexes.sort((left, right) => left - right);
}

function validIndexSet(value: unknown, messageCount: number): Set<number> | null {
  if (!Array.isArray(value)) return null;

  const seen = new Set<number>();
  for (const index of value) {
    if (typeof index !== 'number' || !Number.isInteger(index)) return null;
    if (index < 0 || index >= messageCount) return null;
    if (seen.has(index)) return null;
    seen.add(index);
  }
  return seen;
}

/**
 * 不信任 QqSender：在写 assistant L0 前校验 SendResult index 不变量。
 * ambiguous_failure 只要求两个数组本身合法，不要求并集完整。
 */
function isValidSendResult(sendResult: SendResult, messageCount: number): boolean {
  if (sendResult === null || typeof sendResult !== 'object') return false;

  const sent = validIndexSet(sendResult.sentIndexes, messageCount);
  const failed = validIndexSet(sendResult.failedIndexes, messageCount);
  if (sent === null || failed === null) return false;

  for (const index of sent) {
    if (failed.has(index)) return false;
  }

  if (sendResult.outcome === 'ambiguous_failure') return true;

  if (
    sendResult.outcome !== 'all_sent' &&
    sendResult.outcome !== 'partial' &&
    sendResult.outcome !== 'none_sent'
  ) {
    return false;
  }

  // 无重复、无重叠且全部在范围内时，size 之和等于消息数即覆盖全部原始 index。
  if (sent.size + failed.size !== messageCount) return false;

  if (sendResult.outcome === 'all_sent') return failed.size === 0;
  if (sendResult.outcome === 'partial') return sent.size > 0 && failed.size > 0;
  return sent.size === 0;
}

function invalidSendResult(): SendResult {
  return {
    outcome: 'ambiguous_failure',
    sentIndexes: [],
    failedIndexes: [],
    retryable: false,
    retryAfterMs: null,
    reason: 'invalid_send_result',
  };
}

/**
 * QQ 整回合编排（P2 T4c，依赖注入）：
 *
 * markProcessing → Agent 推理（不写 user/assistant L0）→ ReplyPlan
 * → QqSender.send → 只提交实际送达的 assistant 内容 → 每个 eventId 收尾。
 *
 * - 同 session 由 registry.runExclusive 串行，跨 session 可并行；
 * - 只在 sentIndexes 命中的 messages 上写 assistant L0/history，不整包重发；
 * - 零送达/歧义只 markFailed，不写 assistant；
 * - wake.omittedEventIds 不参与本轮 Receipt 状态迁移；
 * - 不直接触网关/QQ，只通过注入的 sender。
 */
export async function runQqTurn(options: RunQqTurnOptions): Promise<QqTurnResult> {
  const {
    registry,
    sessionKey,
    wake,
    sender,
    receipts,
    target,
    maxPerTurn,
    signal,
  } = options;

  if (wake.items.length === 0) return emptyTurnResult();

  const eventIds = wake.items.map((item) => item.eventId);
  const audience = wakeAudience(wake);
  const memberLimited = audience === 'member';
  const onlyItem = wake.items.length === 1 ? wake.items[0]! : null;
  const commandsAllowed =
    options.commands !== undefined &&
    onlyItem !== null &&
    onlyItem.origin === 'live' &&
    isOwnerWakeItem(onlyItem);

  return registry.runExclusive(sessionKey, async (agent) => {
    // 1) 首次 provider 调用前先把所有 eventId 置为 processing。
    let processingFailed = false;
    try {
      for (const eventId of eventIds) {
        if (!receipts.markProcessing(eventId)) processingFailed = true;
      }
    } catch (error) {
      markFailedAll(receipts, eventIds, 'processing 状态迁移失败');
      throw error;
    }
    if (processingFailed) {
      markFailedAll(receipts, eventIds, 'processing 状态迁移失败');
      throw new Error('runQqTurn：markProcessing 失败，未调用模型');
    }

    // 记忆命令是控制面，不交给模型解释；只在单条批时处理，避免混批歧义。
    let commandResult: QqMemoryCommandResult | null = null;
    if (commandsAllowed && options.commands) {
      try {
        commandResult = await options.commands(wake.items[0]!.text, agent);
      } catch (error) {
        markFailedAll(receipts, eventIds, '记忆命令执行失败');
        throw error;
      }
    }

    if (commandResult?.handled) {
      // !note 写入后立即刷新静态段，下一轮生效。
      agent.refreshSelfNote();
      const plan = buildReplyPlan(commandResult.messages.join('\n'), { maxPerTurn });
      if (plan.messages.length === 0) {
        const failure = markFailedAll(receipts, eventIds, '空命令回复，未发送');
        if (failure !== null) throw failure;
        return { plan, sendResult: null, deliveredText: '' };
      }

      let sendResult: SendResult;
      try {
        if (memberLimited && options.memberReplyGate) {
          const allowed = await options.memberReplyGate.acquire(sessionKey, signal);
          if (!allowed) {
            const rateLimited = rateLimitedSendResult(plan.messages.length);
            const failure = markFailedAll(receipts, eventIds, '成员回复限流');
            if (failure !== null) throw failure;
            return { plan, sendResult: rateLimited, deliveredText: '' };
          }
        }
        sendResult = await sender.send(target, plan.messages, { signal });
      } catch (error) {
        markFailedAll(receipts, eventIds, '命令回复发送失败');
        throw error;
      }

      if (!isValidSendResult(sendResult, plan.messages.length)) {
        const failure = markFailedAll(receipts, eventIds, '发送结果非法');
        if (failure !== null) throw failure;
        return { plan, sendResult: invalidSendResult(), deliveredText: '' };
      }

      const ambiguous = sendResult.outcome === 'ambiguous_failure';
      const deliveredIndexes = ambiguous
        ? []
        : orderedDeliveredIndexes(sendResult.sentIndexes, plan.messages.length);
      const deliveredText = deliveredIndexes
        .map((index) => plan.messages[index]!)
        .join(DELIVERY_SEPARATOR);

      if (!ambiguous && sendResult.sentIndexes.length > 0) {
        markDoneAll(receipts, eventIds, sendResult.sentIndexes, sendResult.failedIndexes);
      } else {
        const reason = ambiguous
          ? sendResult.reason ?? '发送结果歧义'
          : sendResult.reason ?? `发送失败：${sendResult.outcome}`;
        const failure = markFailedAll(receipts, eventIds, reason);
        if (failure !== null) throw failure;
      }

      return { plan, sendResult, deliveredText };
    }

    // 2) 模型输入与原始记录分离：接收层已写 user L0，本轮不重复写。
    let turnText: string;
    try {
      const turnOptions: RunTurnOptions = {
        signal,
        writeUserL0: false,
        writeAssistantL0: false,
      };
      if (options.webToolsAllowed === true && options.webTools) {
        turnOptions.webTools = options.webTools;
      }
      if (options.memoryToolsAllowed === true && options.memoryTools) {
        turnOptions.memoryTools = options.memoryTools;
      }
      if (options.codeToolsAllowed === true && options.codeTools) {
        turnOptions.codeTools = options.codeTools;
      }
      const result = await agent.runTurn(wake.modelText, turnOptions);
      turnText = result.text;
    } catch (error) {
      markFailedAll(receipts, eventIds, '模型调用失败');
      throw error;
    }

    // 3) 空计划不发送。
    const plan = buildReplyPlan(turnText, { maxPerTurn });
    if (plan.messages.length === 0) {
      const failure = markFailedAll(receipts, eventIds, '空回复，未发送');
      if (failure !== null) throw failure;
      return { plan, sendResult: null, deliveredText: '' };
    }

    // 4) 只发送一次；重试与 index 校验由 QqSender 负责。
    let sendResult: SendResult;
    try {
      if (memberLimited && options.memberReplyGate) {
        const allowed = await options.memberReplyGate.acquire(sessionKey, signal);
        if (!allowed) {
          const rateLimited = rateLimitedSendResult(plan.messages.length);
          const failure = markFailedAll(receipts, eventIds, '成员回复限流');
          if (failure !== null) throw failure;
          return { plan, sendResult: rateLimited, deliveredText: '' };
        }
      }
      sendResult = await sender.send(target, plan.messages, { signal });
    } catch (error) {
      markFailedAll(receipts, eventIds, '发送失败');
      throw error;
    }

    // 4.5) 本地校验 sender 返回值；违例归一化为歧义，绝不提交 assistant。
    if (!isValidSendResult(sendResult, plan.messages.length)) {
      sendResult = invalidSendResult();
      const failure = markFailedAll(receipts, eventIds, '发送结果非法');
      if (failure !== null) throw failure;
      return { plan, sendResult, deliveredText: '' };
    }

    // 5) 歧义一律视为零送达；否则按原始 index 顺序拼出实际送达内容。
    const ambiguous = sendResult.outcome === 'ambiguous_failure';
    const deliveredIndexes = ambiguous
      ? []
      : orderedDeliveredIndexes(sendResult.sentIndexes, plan.messages.length);
    const deliveredText = deliveredIndexes
      .map((index) => plan.messages[index]!)
      .join(DELIVERY_SEPARATOR);

    if (deliveredText.length > 0) {
      try {
        agent.commitAssistant(deliveredText);
      } catch (error) {
        markFailedAll(receipts, eventIds, 'assistant 收尾失败');
        throw error;
      }
    }

    // 6) 部分送达也是 done；零送达或歧义是 failed。
    if (!ambiguous && sendResult.sentIndexes.length > 0) {
      markDoneAll(receipts, eventIds, sendResult.sentIndexes, sendResult.failedIndexes);
    } else {
      const reason = ambiguous
        ? sendResult.reason ?? '发送结果歧义'
        : sendResult.reason ?? `发送失败：${sendResult.outcome}`;
      const failure = markFailedAll(receipts, eventIds, reason);
      if (failure !== null) throw failure;
    }

    return { plan, sendResult, deliveredText };
  });
}
