import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type RecordSource = 'cli' | 'qq';
export type RecordRole = 'user' | 'assistant';

/** 群消息引用元数据；独立字段保存，不拼进 text。 */
export interface RecordQuote {
  fromName: string;
  text: string;
}

/**
 * L0 原文记录（人类可读 JSONL）。
 * - id：唯一标识，重复 id 会被跳过（去重）
 * - src：入口来源（cli / qq）
 * - sessionKey：会话标识（QQ 号/群号映射在 P2 落盘）
 * - t：ISO 时间字符串，按本地时区月份分片
 * - role：说话人
 * - text：完整原文（L0 保真，不截断）
 * - speaker：群昵称元数据；私聊/旧记录可缺省
 * - quote：引用元数据；旧记录可缺省
 * - isAtBot：群消息是否 @/引用机器人；独立元数据，旧记录可缺省
 * - senderQqId：发送者 QQ（内部元数据，由线上 sender.qqId 派生）；旧记录可缺省
 * - modelEligible：是否允许进入模型/检索上下文；旧记录可缺省（群聊缺省按 fail-closed）
 */
export interface RawRecord {
  id: string;
  src: RecordSource;
  sessionKey: string;
  t: string;
  role: RecordRole;
  text: string;
  speaker?: string | null;
  quote?: RecordQuote | null;
  isAtBot?: boolean;
  senderQqId?: string | null;
  modelEligible?: boolean;
}

export interface AppendInput {
  id?: string;
  src: RecordSource;
  sessionKey: string;
  role: RecordRole;
  text: string;
  speaker?: string | null;
  quote?: RecordQuote | null;
  isAtBot?: boolean;
  senderQqId?: string | null;
  modelEligible?: boolean;
  /** 便于测试注入时间；不传则用 Date.now()。 */
  t?: number;
}

export type AppendResult =
  | { kind: 'inserted'; record: RawRecord }
  | { kind: 'duplicate'; record: RawRecord }
  | { kind: 'write_error'; message: string };

export interface EventStoreOptions {
  /** events 目录（通常是 <stateDir>/memory/events） */
  dir: string;
  now?: () => number;
  onWarn?: (message: string) => void;
}

const SHARD_RE = /^\d{4}-\d{2}\.jsonl$/;

/**
 * L0 只追加存储：
 * - 按月分片 state/memory/events/YYYY-MM.jsonl
 * - 同 id 去重（启动时懒扫描一次全部分片建索引，坏行跳过）
 * - 写入失败只告警一次，绝不打断对话
 */
export class EventStore {
  readonly dir: string;
  private readonly now: () => number;
  private readonly onWarn: (message: string) => void;

  private indexLoaded = false;
  /** id → 完整已落盘记录；duplicate 直接同步返回，无需二次读盘。 */
  private readonly recordsById = new Map<string, RawRecord>();
  private warnedWriteFailure = false;

  constructor(options: EventStoreOptions) {
    this.dir = options.dir;
    this.now = options.now ?? Date.now;
    this.onWarn = options.onWarn ?? ((message) => console.warn(message));
  }

  /**
   * 三态写入：inserted 返回落盘记录；duplicate 表示同 id 已存在；
   * write_error 返回底层错误信息（写失败仍按实例只告警一次）。
   */
  appendResult(input: AppendInput): AppendResult {
    this.ensureIndex();

    const id = input.id ?? randomUUID();
    const existing = this.recordsById.get(id);
    if (existing) return { kind: 'duplicate', record: existing };

    const ts = input.t ?? this.now();
    const record: RawRecord = {
      id,
      src: input.src,
      sessionKey: input.sessionKey,
      t: new Date(ts).toISOString(),
      role: input.role,
      text: input.text,
    };
    if (input.speaker !== undefined) record.speaker = input.speaker;
    if (input.quote !== undefined) record.quote = input.quote;
    if (input.isAtBot !== undefined) record.isAtBot = input.isAtBot;
    if (input.senderQqId !== undefined) record.senderQqId = input.senderQqId;
    if (input.modelEligible !== undefined) record.modelEligible = input.modelEligible;

    try {
      mkdirSync(this.dir, { recursive: true });
      appendFileSync(this.shardPath(monthOf(ts)), `${JSON.stringify(record)}\n`, 'utf8');
      this.recordsById.set(id, record);
      return { kind: 'inserted', record };
    } catch (err) {
      if (!this.warnedWriteFailure) {
        this.warnedWriteFailure = true;
        const reason = err instanceof Error ? err.message : String(err);
        this.onWarn(`L0 写入失败（后续同类错误不再提示）：${reason}`);
      }
      return {
        kind: 'write_error',
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** CLI 兼容包装：inserted 返回记录，duplicate / write_error 返回 null。 */
  append(input: AppendInput): RawRecord | null {
    const result = this.appendResult(input);
    return result.kind === 'inserted' ? result.record : null;
  }

  /** 列出所有合法分片的月份（升序）；目录不可读时返回空数组。 */
  listMonths(): string[] {
    try {
      if (!existsSync(this.dir)) return [];
      return readdirSync(this.dir)
        .filter((name) => SHARD_RE.test(name))
        .map((name) => name.slice(0, 7))
        .sort();
    } catch {
      return [];
    }
  }

  /** 读取某月分片里的合法记录；坏行自动跳过。month 形如 2026-11。 */
  readMonth(month: string): RawRecord[] {
    const path = this.shardPath(month);
    if (!existsSync(path)) return [];
    const records: RawRecord[] = [];
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const record = parseLine(line);
      if (record) records.push(record);
    }
    return records;
  }

  private shardPath(month: string): string {
    return join(this.dir, `${month}.jsonl`);
  }

  private ensureIndex(): void {
    if (this.indexLoaded) return;
    this.indexLoaded = true;

    try {
      if (!existsSync(this.dir)) return;
      for (const name of readdirSync(this.dir)) {
        if (!SHARD_RE.test(name)) continue;
        try {
          for (const line of readFileSync(join(this.dir, name), 'utf8').split('\n')) {
            const record = parseLine(line);
            if (record) this.recordsById.set(record.id, record);
          }
        } catch {
          // 单个分片读不了不影响其他分片与后续写入
        }
      }
    } catch {
      // 目录本身不可读（例如被同名文件占位）时，交给 append 的写入失败分支告警
    }
  }
}

/** 本地时区月份；分片面向人阅读，与 tail 时的日期感一致。 */
export function monthOf(ts: number): string {
  const date = new Date(ts);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function parseLine(line: string): RawRecord | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const value: unknown = JSON.parse(trimmed);
    return isRawRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function isRawRecord(value: unknown): value is RawRecord {
  if (!value || typeof value !== 'object') return false;
  const rec = value as Record<string, unknown>;
  return (
    typeof rec.id === 'string' &&
    (rec.src === 'cli' || rec.src === 'qq') &&
    typeof rec.sessionKey === 'string' &&
    typeof rec.t === 'string' &&
    (rec.role === 'user' || rec.role === 'assistant') &&
    typeof rec.text === 'string'
  );
}
