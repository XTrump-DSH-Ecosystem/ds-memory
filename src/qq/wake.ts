import {
  DEFAULT_BATCH_LIMITS,
  planBatch,
  type BatchLimits,
} from './batch.ts';
import type { InboxItem, WakeItem, WakePacket } from './types.ts';

/** 群唤醒策略：mention = 仅 @/引用机器人；all = 全部群消息。 */
export type GroupWakeMode = 'mention' | 'all';

export interface WakeOptions {
  groupWake?: GroupWakeMode;
  /** 覆盖默认合批上限（通常来自 qq.batch* 配置）。 */
  limits?: Partial<BatchLimits>;
  /** 缺省取首条消息的 sessionKey。 */
  sessionKey?: string;
}

export interface WakeBatchResult {
  /**
   * `null` = 不要调用模型。
   * 可能是群 mention 未命中，也可能是唤醒条目全部落在窗口外（见 omitted）。
   */
  packet: WakePacket | null;
  /** 群 mention 模式下未命中 @/引用、只写 L0 不唤醒的条目。 */
  storedOnly: InboxItem[];
  /**
   * 未进包的唤醒条目，按原序保留。
   * 只要非空，调用方必须 requeue，并以新的首条时间重新合批，原文不丢。
   */
  omitted: InboxItem[];
}

/** 单条消息是否唤醒模型；私聊恒为 true。 */
export function shouldWake(
  item: InboxItem,
  groupWake: GroupWakeMode = 'mention',
): boolean {
  if (item.kind === 'private') return true;
  return groupWake === 'all' || item.isAtBot;
}

/**
 * 生成有界唤醒结果（严格按 docs/P2-INTERFACES.md §2）：
 * - items[].text 永远是完整原文，不拼接昵称/引用/唤醒标签；
 * - modelText 中的说话人标签、引用前缀、单条截断与省略提示计入总字符上限；
 * - 群 mention 模式下未命中 @/引用的消息只保存，不进入 modelText/omittedEventIds。
 */
export function buildWakeBatch(
  items: readonly InboxItem[],
  options: WakeOptions = {},
): WakeBatchResult {
  if (items.length === 0) return { packet: null, storedOnly: [], omitted: [] };

  const groupWake = options.groupWake ?? 'mention';
  const sessionKey = options.sessionKey ?? items[0]!.sessionKey;
  const limits: BatchLimits = { ...DEFAULT_BATCH_LIMITS, ...options.limits };

  const woken: InboxItem[] = [];
  const storedOnly: InboxItem[] = [];
  for (const item of items) {
    if (shouldWake(item, groupWake)) {
      woken.push(item);
    } else {
      storedOnly.push(item);
    }
  }

  if (woken.length === 0) return { packet: null, storedOnly, omitted: [] };

  // 窗口自「本批第一条消息」起算；即使首条只保存，也不得把窗口往后挪。
  const plan = planBatch(woken, limits, { windowStartAt: items[0]!.receivedAt });

  // 没有任何唤醒条目进入窗口时，不能生成空 items 的模型包；
  // omitted 保留全部唤醒条目，交由调用方重新合批。
  if (plan.included.length === 0) {
    return { packet: null, storedOnly, omitted: plan.omitted };
  }

  const wakeItems: WakeItem[] = plan.included.map(({ item }) => ({
    eventId: item.eventId,
    speaker: item.speaker,
    ...(item.senderRole ? { senderRole: item.senderRole } : {}),
    ...(item.origin ? { origin: item.origin } : {}),
    quote: item.quote,
    text: item.text,
    at: item.receivedAt,
  }));

  return {
    packet: {
      sessionKey,
      items: wakeItems,
      omittedEventIds: plan.omitted.map((item) => item.eventId),
      modelText: plan.modelText,
      totalChars: plan.totalChars,
      truncatedCount: plan.truncatedCount,
    },
    storedOnly,
    omitted: plan.omitted,
  };
}

/** 只需要唤醒包时的便捷入口；null 即「只保存」信号。 */
export function buildWakePacket(
  items: readonly InboxItem[],
  options: WakeOptions = {},
): WakePacket | null {
  return buildWakeBatch(items, options).packet;
}
