import type { InboxItem } from './types.ts';

/** 合批硬上限；与 qq.batch* 配置默认值一致。 */
export interface BatchLimits {
  /** 窗口自本批首条消息起算（毫秒）。 */
  windowMs: number;
  /** 本批最多包含的消息条数。 */
  maxMessages: number;
  /** 单条消息正文进入模型前的最大字符数。 */
  messageMaxChars: number;
  /** modelText 总字符上限（含说话人标签、引用前缀、省略提示）。 */
  maxChars: number;
}

export const DEFAULT_BATCH_LIMITS: BatchLimits = {
  windowMs: 2000,
  maxMessages: 12,
  messageMaxChars: 300,
  maxChars: 4000,
};

/** 单条正文被截断时追加的提示。 */
export const ITEM_TRUNCATION_MARKER = '…[已截断]';

/** 因条数/总字符上限未进入本批时，modelText 尾部的省略提示。 */
export function formatOmissionHint(count: number): string {
  return `…[已省略 ${count} 条，进入下一批]`;
}

export interface BatchPlanOptions {
  /**
   * 窗口起点；缺省取 items[0].receivedAt。
   * 群 mention 模式下先按唤醒策略过滤时，可显式传入过滤前首条消息的时间。
   */
  windowStartAt?: number;
}

export interface RenderedBatchItem {
  item: InboxItem;
  /** 单条模型输入（标签 + 引用前缀 + 截断后的正文）。 */
  modelText: string;
  /** 正文因单条 300 字上限被截断。 */
  truncated: boolean;
}

export interface BatchPlan {
  /** 本批进入模型的条目（≤ maxMessages，且总字符受限）。 */
  included: RenderedBatchItem[];
  /** 未进入本批的原始条目；必须按原序进入下一批，原文不丢。 */
  omitted: InboxItem[];
  /** 有界模型输入；含标签、引用前缀与尾部省略提示。 */
  modelText: string;
  /** modelText 字符数（≤ maxChars）。 */
  totalChars: number;
  /** 因单条正文超限被截断的条数。 */
  truncatedCount: number;
}

/** 从 qq 配置片段构造合批上限，避免调用方散落字段映射。 */
export function batchLimitsFromConfig(config: {
  batchWindowMs: number;
  batchMaxMessages: number;
  batchMessageMaxChars: number;
  batchMaxChars: number;
}): BatchLimits {
  return {
    windowMs: config.batchWindowMs,
    maxMessages: config.batchMaxMessages,
    messageMaxChars: config.batchMessageMaxChars,
    maxChars: config.batchMaxChars,
  };
}

function charCount(text: string): number {
  return Array.from(text).length;
}

function takeChars(text: string, limit: number): string {
  if (limit <= 0) return '';
  return Array.from(text).slice(0, limit).join('');
}

/** 按字符截断并追加标记；返回值字符数不超过 limit。 */
function clipBody(text: string, limit: number): { text: string; truncated: boolean } {
  if (charCount(text) <= limit) return { text, truncated: false };

  const markerChars = charCount(ITEM_TRUNCATION_MARKER);
  if (limit <= markerChars) {
    return { text: takeChars(ITEM_TRUNCATION_MARKER, limit), truncated: true };
  }
  return {
    text: takeChars(text, limit - markerChars) + ITEM_TRUNCATION_MARKER,
    truncated: true,
  };
}

/**
 * 组装单条模型输入：
 * - 群消息带 `昵称：` 说话人标签；
 * - quote 拼成 `[引用 张三：原文] ` 前缀；
 * - 正文按单条上限截断并追加标记；
 * - 标签/前缀不写回 item.text（L0 保真）。
 */
export function renderBatchItem(item: InboxItem, limits: BatchLimits): RenderedBatchItem {
  const roleLabel =
    item.kind === 'group'
      ? item.senderRole === 'owner'
        ? '[管理员] '
        : '[群友] '
      : '';
  const speakerLabel =
    item.kind === 'group' && item.speaker ? `${roleLabel}${item.speaker}：` : '';
  const quotePrefix = item.quote
    ? `[引用 ${item.quote.fromName}：${clipBody(item.quote.text, limits.messageMaxChars).text}] `
    : '';
  const body = clipBody(item.text, limits.messageMaxChars);

  return {
    item,
    modelText: `${speakerLabel}${quotePrefix}${body.text}`,
    truncated: body.truncated,
  };
}

function composeModelText(segments: readonly string[], hint: string): string {
  const body = segments.filter((segment) => segment.length > 0).join('\n');
  if (hint.length === 0) return body;
  return body.length > 0 ? `${body}\n${hint}` : hint;
}

/**
 * 对一个会话当前排队的消息做合批：
 * - 窗口自首条起算，超出窗口的条目整段进入下一批；
 * - 条数/单条/总字符三重上限，任一超限都只把剩余条目移出本批；
 * - 不丢弃任何原文，omitted 保持原序供调用方 requeue。
 */
export function planBatch(
  items: readonly InboxItem[],
  limits: BatchLimits = DEFAULT_BATCH_LIMITS,
  options: BatchPlanOptions = {},
): BatchPlan {
  if (items.length === 0) {
    return {
      included: [],
      omitted: [],
      modelText: '',
      totalChars: 0,
      truncatedCount: 0,
    };
  }

  const windowStartAt = options.windowStartAt ?? items[0]!.receivedAt;
  const inWindow: InboxItem[] = [];
  const outside: InboxItem[] = [];
  let windowClosed = false;

  for (const item of items) {
    if (!windowClosed && item.receivedAt - windowStartAt <= limits.windowMs) {
      inWindow.push(item);
    } else {
      windowClosed = true;
      outside.push(item);
    }
  }

  const included: RenderedBatchItem[] = [];
  const omittedInWindow: InboxItem[] = [];
  let capReached = false;

  for (const item of inWindow) {
    if (capReached || included.length >= limits.maxMessages) {
      capReached = true;
      omittedInWindow.push(item);
      continue;
    }

    const rendered = renderBatchItem(item, limits);
    const remainingAfterThis = inWindow.length - included.length - 1 + outside.length;
    const hint = remainingAfterThis > 0 ? formatOmissionHint(remainingAfterThis) : '';
    const segments = [...included.map((entry) => entry.modelText), rendered.modelText];

    // 预留分隔符与省略提示，保证最终 modelText 不超过总上限。
    if (charCount(composeModelText(segments, hint)) > limits.maxChars) {
      capReached = true;
      omittedInWindow.push(item);
      continue;
    }

    included.push(rendered);
  }

  // 退化配置（例如 maxChars 小于单条固定开销）下也必须前进：
  // 只要窗口内有消息，就强制纳入首条，按 maxChars 硬截断模型文本。
  if (included.length === 0 && inWindow.length > 0) {
    const first = inWindow[0]!;
    const rendered = renderBatchItem(first, limits);
    included.push({
      ...rendered,
      modelText: takeChars(rendered.modelText, limits.maxChars),
    });

    const omittedIndex = omittedInWindow.indexOf(first);
    if (omittedIndex >= 0) omittedInWindow.splice(omittedIndex, 1);
  }

  const omitted = [...omittedInWindow, ...outside];
  const hint = omitted.length > 0 ? formatOmissionHint(omitted.length) : '';
  let modelText = composeModelText(included.map((entry) => entry.modelText), hint);

  // 极端配置下（例如 maxChars 小于单条固定开销）兜底，硬上限优先。
  if (charCount(modelText) > limits.maxChars) {
    modelText = takeChars(modelText, limits.maxChars);
  }

  return {
    included,
    omitted,
    modelText,
    totalChars: charCount(modelText),
    truncatedCount: included.filter((entry) => entry.truncated).length,
  };
}
