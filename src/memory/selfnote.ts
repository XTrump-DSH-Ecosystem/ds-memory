import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sanitizeSessionKey } from '../state/paths.ts';
import { truncateText } from '../util/string.ts';

/**
 * L2 selfNote 层。
 *
 * 文件：state/memory/selfnotes/<sanitized-sessionKey>.jsonl，append-only + 修订折叠。
 *
 * 记录字段：
 * - id：笔记 id（同文本去重时复用同 id 追加修订）
 * - v：记录版本号（当前 1）
 * - sessionKey：所属会话
 * - text：自己写下的一句话（≤300 字）
 * - createdAt：首次写下时间（ISO）
 * - lastTouchedAt：最后一次刷新时间（ISO）
 * - archived：是否已归档（可选；旧 JSONL 缺省视为未归档，只归档不删除）
 *
 * 纪律：总数上限 max（默认 40），超出按 lastTouchedAt 淘汰最旧——
 * 淘汰只体现在「不再加载」，磁盘上的历史仍保留（人类可读、只归档不删除）。
 * 显式归档通过 archiveMatching 追加 archived:true 修订，绝不物理删除。
 */
export type SelfNoteRecord = {
  id: string;
  v: 1;
  sessionKey: string;
  text: string;
  createdAt: string;
  lastTouchedAt: string;
  archived?: boolean;
};

export const SELF_NOTE_TEXT_LIMIT = 300;
export const NICKNAME_PREFERENCE_PREFIX = '主人指定的称呼是';

export function isNicknamePreferenceText(text: string): boolean {
  return text.startsWith(NICKNAME_PREFERENCE_PREFIX);
}

export interface SelfNoteOptions {
  dir: string;
  max: number;
  bootstrapLimit: number;
  now?: () => number;
  onWarn?: (message: string) => void;
}

export class SelfNoteStore {
  readonly dir: string;

  private readonly max: number;
  private readonly bootstrapLimit: number;
  private readonly now: () => number;
  private readonly onWarn: (message: string) => void;

  private readonly cache = new Map<string, Map<string, SelfNoteRecord>>();
  private readonly loaded = new Set<string>();
  private warnedWriteFailure = false;

  constructor(options: SelfNoteOptions) {
    this.dir = options.dir;
    this.max = options.max;
    this.bootstrapLimit = options.bootstrapLimit;
    this.now = options.now ?? Date.now;
    this.onWarn = options.onWarn ?? ((message) => console.warn(message));
  }

  /** 写入（同文本只刷新 lastTouchedAt）。返回 null 表示写盘失败。 */
  upsert(sessionKey: string, text: string): SelfNoteRecord | null {
    const normalized = truncateText(text.replace(/\s+/g, ' ').trim(), SELF_NOTE_TEXT_LIMIT);
    if (normalized.length === 0) return null;

    this.ensureLoaded(sessionKey);
    const nowIso = new Date(this.now()).toISOString();
    const notes = this.cache.get(sessionKey)!;

    const existing = [...notes.values()]
      .filter((note) => !note.archived && note.text === normalized)
      .sort((a, b) => Date.parse(b.lastTouchedAt) - Date.parse(a.lastTouchedAt))[0];

    const record: SelfNoteRecord = existing
      ? { ...existing, lastTouchedAt: nowIso }
      : {
          id: randomUUID(),
          v: 1,
          sessionKey,
          text: normalized,
          createdAt: nowIso,
          lastTouchedAt: nowIso,
        };

    if (!this.append(sessionKey, record)) return null;
    notes.set(record.id, record);
    return record;
  }

  /** 当前有效的笔记（按 lastTouchedAt 升序），最多 max 条（保留最新的）。 */
  list(sessionKey: string): SelfNoteRecord[] {
    this.ensureLoaded(sessionKey);
    const notes = [...this.cache.get(sessionKey)!.values()].filter((note) => !note.archived);

    // 同文本去重，保留最后触碰的那条。
    const byText = new Map<string, SelfNoteRecord>();
    for (const note of notes) {
      const prev = byText.get(note.text);
      if (!prev || Date.parse(note.lastTouchedAt) > Date.parse(prev.lastTouchedAt)) {
        byText.set(note.text, note);
      }
    }

    return [...byText.values()]
      .sort((a, b) => Date.parse(b.lastTouchedAt) - Date.parse(a.lastTouchedAt))
      .slice(0, this.max)
      .sort((a, b) => Date.parse(a.lastTouchedAt) - Date.parse(b.lastTouchedAt));
  }

  count(sessionKey: string): number {
    return this.list(sessionKey).length;
  }

  /**
   * 归档匹配的未归档笔记：逐条追加 archived:true 修订，写盘成功才更新 cache。
   * 返回实际归档条数；不物理删除原文。
   */
  archiveMatching(
    sessionKey: string,
    predicate: (record: SelfNoteRecord) => boolean,
  ): number {
    this.ensureLoaded(sessionKey);
    const notes = this.cache.get(sessionKey)!;
    let archived = 0;

    for (const note of [...notes.values()]) {
      if (note.archived || !predicate(note)) continue;
      const next: SelfNoteRecord = { ...note, archived: true };
      if (!this.append(sessionKey, next)) continue;
      notes.set(next.id, next);
      archived += 1;
    }

    return archived;
  }

  /**
   * 冷启动注入：普通 selfNote 的最近 bootstrapLimit 条，按时间正序展示。
   * 旧版自动生成的称呼偏好不再展示（称呼已迁到人格卡），但原文仍保留在磁盘；
   * isNicknamePreferenceText 只供 !称呼 归档旧偏好使用。
   * 返回空串表示没有可展示的笔记。
   */
  bootstrapText(sessionKey: string): string {
    const limit = Math.max(0, Math.floor(this.bootstrapLimit));
    if (limit === 0) return '';

    const regular = this.list(sessionKey)
      .filter((note) => !note.text.startsWith(NICKNAME_PREFERENCE_PREFIX))
      .slice(-limit);
    if (regular.length === 0) return '';

    return `【你对自己的认识】这些是你自己写下的：\n${regular
      .map((note) => `- ${note.text}`)
      .join('\n')}`;
  }

  private append(sessionKey: string, record: SelfNoteRecord): boolean {
    try {
      mkdirSync(this.dir, { recursive: true });
      appendFileSync(this.path(sessionKey), `${JSON.stringify(record)}\n`, 'utf8');
      return true;
    } catch (err) {
      if (!this.warnedWriteFailure) {
        this.warnedWriteFailure = true;
        const reason = err instanceof Error ? err.message : String(err);
        this.onWarn(`selfNote 写入失败（后续同类错误不再提示）：${reason}`);
      }
      return false;
    }
  }

  private path(sessionKey: string): string {
    return join(this.dir, `${sanitizeSessionKey(sessionKey)}.jsonl`);
  }

  private ensureLoaded(sessionKey: string): void {
    if (this.loaded.has(sessionKey)) return;
    this.loaded.add(sessionKey);

    const notes = new Map<string, SelfNoteRecord>();
    this.cache.set(sessionKey, notes);

    const path = this.path(sessionKey);
    if (!existsSync(path)) return;

    try {
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        const record = parseNoteLine(line);
        if (!record || record.sessionKey !== sessionKey) continue;
        notes.set(record.id, record);
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.onWarn(`selfNote 读取失败（本轮按空笔记处理）：${reason}`);
    }
  }
}

function parseNoteLine(line: string): SelfNoteRecord | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const value: unknown = JSON.parse(trimmed);
    if (!value || typeof value !== 'object') return null;
    const rec = value as Record<string, unknown>;
    if (rec.v !== 1) return null;
    if (typeof rec.id !== 'string' || typeof rec.sessionKey !== 'string') return null;
    if (typeof rec.text !== 'string') return null;
    if (typeof rec.createdAt !== 'string' || typeof rec.lastTouchedAt !== 'string') return null;
    return {
      id: rec.id,
      v: 1,
      sessionKey: rec.sessionKey,
      text: rec.text,
      createdAt: rec.createdAt,
      lastTouchedAt: rec.lastTouchedAt,
      ...(rec.archived === true ? { archived: true } : {}),
    };
  } catch {
    return null;
  }
}
