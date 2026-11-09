import type { ChatMessage, Provider } from '../provider/types.ts';
import { TAG_WEIGHTS, type FactTag } from '../memory/facts.ts';
import { truncateText } from '../util/string.ts';

/**
 * 压缩（ADR-D6）。顺序不可变：
 *   ① 记忆整理轮（静默，一次模型调用，输出 JSON）
 *   ② 写 facts / selfNote（失败 → 本次放弃，绝不截断历史）
 *   ③ 用摘要替换旧历史，保留最近 2 轮原文
 *   ④ 持久化 state/sessions/<key>.json（重启后摘要仍在）
 *
 * 任何一步失败 = 本次不压（宁可不省，不可丢），由调用方做防抖。
 */

export const KEEP_RECENT_TURNS = 2;
export const COMPACTION_TIMEOUT_MS = 120_000;

/**
 * 粗略 token 估算：所有 content 的字符数之和 ÷ 1.5。
 * 这是中文近似值（一个汉字约 0.6~1 token），只用于「要不要压缩」的阈值判断，
 * 不作为计费依据。
 */
export function estimateTokens(messages: ChatMessage[]): number {
  let chars = 0;
  for (const message of messages) chars += Array.from(message.content).length;
  return Math.round(chars / 1.5);
}

export interface CompactionFact {
  text: string;
  tag: FactTag;
}

export interface CompactionPayload {
  facts: CompactionFact[];
  selfNotes: string[];
  summary: string;
}

export const COMPACTION_TASK = `你现在做一次静默的记忆整理（不要回复对话内容，只输出 JSON）。
从对话里抽取：
1. 值得长期记住的一句话事实（≤120 字），tag 只能是 identity / agreement / emotion / preference / meme / misc
2. 最多 2 条「你对自己的认识」（≤300 字）
3. 一段对话摘要（≤500 字，保留人物、事件、未完成事项）

只输出一个 JSON 对象，不要 markdown 代码块，不要任何解释：
{"facts":[{"text":"……","tag":"misc"}],"selfNotes":["……"],"summary":"……"}`;

export interface CompactionRunInput {
  provider: Provider;
  sessionKey: string;
  /** 本轮静态 system 段（记忆整理轮复用同一段，仅额外拼整理任务）。 */
  staticPrompt: string;
  history: ChatMessage[];
  timeoutMs?: number;
  /** 外部中断信号（CLI Ctrl+C）；与内部超时合并后传给 provider。 */
  signal?: AbortSignal;
}

export type CompactionRunResult =
  | { ok: true; payload: CompactionPayload }
  | { ok: false; reason: string };

/** 调模型做整理轮并解析 JSON；解析失败/超时/异常 → ok:false。 */
export async function requestCompaction(input: CompactionRunInput): Promise<CompactionRunResult> {
  if (input.signal?.aborted) return { ok: false, reason: '整理已中断' };

  const messages: ChatMessage[] = [
    { role: 'system', content: `${input.staticPrompt}\n\n${COMPACTION_TASK}` },
    ...input.history,
    { role: 'user', content: '请整理上面的对话，只输出 JSON。' },
  ];

  const timeoutSignal = AbortSignal.timeout(input.timeoutMs ?? COMPACTION_TIMEOUT_MS);
  const signal = input.signal ? AbortSignal.any([input.signal, timeoutSignal]) : timeoutSignal;
  let text = '';

  try {
    for await (const event of input.provider.chat(
      { sessionId: input.sessionKey, messages },
      { signal },
    )) {
      if (event.type === 'text') text += event.text;
    }
  } catch (err) {
    if (input.signal?.aborted) return { ok: false, reason: '整理已中断' };
    return { ok: false, reason: `整理轮调用失败：${describe(err)}` };
  }

  if (input.signal?.aborted) return { ok: false, reason: '整理已中断' };

  const payload = parseCompactionPayload(text);
  if (!payload) return { ok: false, reason: '整理轮输出不是合法 JSON（本次放弃压缩）' };
  return { ok: true, payload };
}

/**
 * 宽松解析：允许模型多嘴解释或包了 ```json 代码块，取第一个 { 到最后一个 }。
 * 校验不过（缺 summary / 空文本）→ null。
 */
export function parseCompactionPayload(raw: string): CompactionPayload | null {
  let candidate = raw.trim();
  if (candidate.length === 0) return null;

  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(candidate);
  if (fenced?.[1]) candidate = fenced[1].trim();

  let value: unknown;
  try {
    value = JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      value = JSON.parse(candidate.slice(start, end + 1));
    } catch {
      return null;
    }
  }

  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;

  const facts: CompactionFact[] = [];
  if (Array.isArray(obj.facts)) {
    for (const item of obj.facts) {
      if (!item || typeof item !== 'object') continue;
      const entry = item as Record<string, unknown>;
      if (typeof entry.text !== 'string' || entry.text.trim().length === 0) continue;
      const tag = typeof entry.tag === 'string' && entry.tag in TAG_WEIGHTS
        ? (entry.tag as FactTag)
        : 'misc';
      facts.push({ text: truncateText(entry.text.trim(), 120), tag });
    }
  }

  const selfNotes: string[] = [];
  if (Array.isArray(obj.selfNotes)) {
    for (const item of obj.selfNotes) {
      if (typeof item !== 'string' || item.trim().length === 0) continue;
      selfNotes.push(truncateText(item.trim(), 300));
      if (selfNotes.length >= 2) break;
    }
  }

  const summary = typeof obj.summary === 'string' ? obj.summary.trim() : '';
  if (summary.length === 0) return null;

  return { facts, selfNotes, summary: truncateText(summary, 500) };
}

/** 截断为「最近 N 轮」原文（1 轮 = user + assistant 两条）。 */
export function keepRecentTurns(history: ChatMessage[], turns: number = KEEP_RECENT_TURNS): ChatMessage[] {
  const maxMessages = Math.max(0, turns * 2);
  return history.slice(-maxMessages);
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
