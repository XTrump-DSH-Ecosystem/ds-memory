import { info as logInfo } from '../util/log.ts';
import type { ReplyPlan } from './types.ts';

/** qq.send.maxPerTurn 的配置默认值；正数不再作为截断上限。 */
export const DEFAULT_MAX_PER_TURN = 3;

/** 单条 QQ 消息的安全字符上限；超过时按安全边界分块，不丢原文。 */
export const QQ_REPLY_MAX_CHARS = 3000;

const SENTENCE_END = new Set(['。', '！', '？', '!', '?', '；', ';', '…']);
const CLOSERS = new Set(['”', '"', '』', '」', '）', ')', ']', '】']);

export interface BuildReplyPlanOptions {
  /** 0 = 静音（返回空计划）；其他正数不再造成截断。 */
  maxPerTurn?: number;
  /** 分块日志出口；默认走 util/log，测试可注入。日志只含分块计数，不含正文。 */
  onInfo?: (message: string) => void;
}

/**
 * ASCII 句点只有不在词内时才算句末，避免把小数、版本号与域名当成边界。
 */
function isAsciiPeriodBoundary(chars: readonly string[], index: number): boolean {
  const previous = chars[index - 1];
  const next = chars[index + 1];
  const wordBefore = previous !== undefined && /[A-Za-z0-9]/.test(previous);
  const wordAfter = next !== undefined && /[A-Za-z0-9]/.test(next);
  return !(wordBefore && wordAfter);
}

function isSentenceEndAt(chars: readonly string[], index: number): boolean {
  const char = chars[index];
  if (char === undefined) return false;
  return SENTENCE_END.has(char) || (char === '.' && isAsciiPeriodBoundary(chars, index));
}

/** 在 [start, windowEnd) 内找最后一句句末（含闭引号/括号），返回切点。 */
function sentenceBoundary(chars: readonly string[], start: number, windowEnd: number): number {
  for (let index = windowEnd - 1; index >= start; index -= 1) {
    if (!isSentenceEndAt(chars, index)) continue;

    let cut = index + 1;
    while (cut < windowEnd && (isSentenceEndAt(chars, cut) || CLOSERS.has(chars[cut]!))) {
      cut += 1;
    }
    return cut;
  }
  return -1;
}

function lastBoundary(
  chars: readonly string[],
  start: number,
  windowEnd: number,
  matches: (char: string) => boolean,
): number {
  for (let index = windowEnd - 1; index > start; index -= 1) {
    if (matches(chars[index - 1]!)) return index;
  }
  return -1;
}

/**
 * 按 3000 字安全上限分块：
 * - 优先在换行后切；
 * - 其次在句末标点（含闭引号/括号）后切；
 * - 再次在空白后切；
 * - 都没有才硬切。
 * 使用码点数组，保证不会切开 emoji 的代理对；所有块拼接后等于原文。
 */
function chunkReply(text: string): string[] {
  const chars = Array.from(text);
  if (chars.length <= QQ_REPLY_MAX_CHARS) return [text];

  const chunks: string[] = [];
  let start = 0;

  while (start < chars.length) {
    const remaining = chars.length - start;
    if (remaining <= QQ_REPLY_MAX_CHARS) {
      chunks.push(chars.slice(start).join(''));
      break;
    }

    const windowEnd = start + QQ_REPLY_MAX_CHARS;
    let cut = lastBoundary(chars, start, windowEnd, (char) => char === '\n' || char === '\r');
    if (cut < 0) cut = sentenceBoundary(chars, start, windowEnd);
    if (cut < 0) cut = lastBoundary(chars, start, windowEnd, (char) => /\s/u.test(char));
    if (cut <= start) cut = windowEnd;

    chunks.push(chars.slice(start, cut).join(''));
    start = cut;
  }

  return chunks;
}

function isMuted(value: number | undefined): boolean {
  if (value === undefined || !Number.isFinite(value)) return false;
  return Math.floor(value) <= 0;
}

/**
 * 生成有序 ReplyPlan（docs/P2-INTERFACES.md §3）：
 * - 空文本/纯空白 → `{ messages: [] }`；
 * - `maxPerTurn=0` → 空计划，保留静音语义；
 * - 普通回复默认完整一条，不按句拆条、不静默截断；
 * - 仅超过 QQ_REPLY_MAX_CHARS 时按安全边界分块，所有原文都保留；
 * - 分块时记一条日志（只含块数，不含正文）；不发送、不触网络。
 */
export function buildReplyPlan(
  text: string,
  options: BuildReplyPlanOptions = {},
): ReplyPlan {
  const normalized = text.trim();
  if (normalized.length === 0) return { messages: [] };
  if (isMuted(options.maxPerTurn)) return { messages: [] };

  const messages = chunkReply(normalized);
  if (messages.length > 1) {
    const write = options.onInfo ?? logInfo;
    write(`回复超过 ${QQ_REPLY_MAX_CHARS} 字安全上限，分为 ${messages.length} 条发送`);
  }

  return { messages };
}
