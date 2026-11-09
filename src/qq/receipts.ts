import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { EventStore, RawRecord } from '../memory/store.ts';
import type {
  Receipt,
  ReceiptStatus,
  ReceiptStore as ReceiptStorePort,
  RecoveredReceipt,
  ReserveInput,
  ReserveResult,
} from './types.ts';

const DEFAULT_DEDUPE_TTL_MS = 600_000;
const MIN_DEDUPE_TTL_MS = 360_000;

const TERMINAL_STATUSES: ReadonlySet<ReceiptStatus> = new Set([
  'done',
  'failed',
  'aborted',
]);

export type ReceiptStoreErrorCode =
  | 'l0_write_failed'
  | 'receipt_write_failed'
  | 'receipt_read_failed'
  | 'receipts_since_missing'
  | 'receipts_since_invalid'
  | 'receipts_since_write_failed'
  | 'invalid_l0_record'
  | 'missing_l0_record';

/** 固定文案错误；绝不携带底层绝对路径或消息正文。 */
export class ReceiptStoreError extends Error {
  readonly code: ReceiptStoreErrorCode;

  constructor(code: ReceiptStoreErrorCode, message: string) {
    super(message);
    this.name = 'ReceiptStoreError';
    this.code = code;
  }
}

export interface ReceiptStoreOptions {
  /** Receipt/水位文件目录（通常是 <stateDir>/qq）。 */
  dir: string;
  store: EventStore;
  dedupeTtlMs?: number;
  now?: () => number;
  onWarn?: (message: string) => void;
}

interface ReceiptMeta {
  v: 1;
  receiptsSince: number;
}

interface ReceiptLine {
  v: 1;
  receipt: Receipt;
}

export function receiptsLogPath(dir: string): string {
  return join(dir, 'qq-receipts.jsonl');
}

export function receiptsMetaPath(dir: string): string {
  return join(dir, 'qq-receipts.meta.json');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isReceiptStatus(value: unknown): value is ReceiptStatus {
  return (
    value === 'received' ||
    value === 'processing' ||
    value === 'done' ||
    value === 'failed' ||
    value === 'aborted'
  );
}

function isNumberOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

function isIndexArrayOrNull(value: unknown): value is number[] | null {
  return (
    value === null ||
    (Array.isArray(value) &&
      value.every((item) => Number.isInteger(item) && item >= 0))
  );
}

function parseReceipt(value: unknown): Receipt | null {
  if (!isRecord(value)) return null;
  if (typeof value.eventId !== 'string' || value.eventId.length === 0) return null;
  if (value.sessionKey !== null && typeof value.sessionKey !== 'string') return null;
  if (!isReceiptStatus(value.status)) return null;
  if (
    value.outcome !== null &&
    value.outcome !== 'replied' &&
    value.outcome !== 'stored_only' &&
    value.outcome !== 'failed' &&
    value.outcome !== 'aborted'
  ) {
    return null;
  }
  if (typeof value.receivedAt !== 'number' || !Number.isFinite(value.receivedAt)) return null;
  if (!isNumberOrNull(value.processingAt) || !isNumberOrNull(value.doneAt)) return null;
  if (value.failureReason !== null && typeof value.failureReason !== 'string') return null;
  if (!isIndexArrayOrNull(value.sentIndexes) || !isIndexArrayOrNull(value.failedIndexes)) {
    return null;
  }

  return {
    eventId: value.eventId,
    sessionKey: value.sessionKey,
    status: value.status,
    outcome: value.outcome,
    receivedAt: value.receivedAt,
    processingAt: value.processingAt,
    doneAt: value.doneAt,
    failureReason: value.failureReason,
    sentIndexes: value.sentIndexes,
    failedIndexes: value.failedIndexes,
  };
}

function cloneReceipt(receipt: Receipt): Receipt {
  return {
    ...receipt,
    sentIndexes: receipt.sentIndexes ? [...receipt.sentIndexes] : null,
    failedIndexes: receipt.failedIndexes ? [...receipt.failedIndexes] : null,
  };
}

function isTerminal(receipt: Receipt): boolean {
  return TERMINAL_STATUSES.has(receipt.status);
}

/**
 * QQ 接收 Receipt（§1）。
 *
 * reserve 是同步临界区：检查 Receipt → appendResult(L0) → 持久化 received，
 * 全程无 await。持久化失败抛 ReceiptStoreError，调用方必须返回 503。
 */
export class ReceiptStore implements ReceiptStorePort {
  private readonly dir: string;
  private readonly store: EventStore;
  private readonly dedupeTtlMs: number;
  private readonly now: () => number;
  private readonly onWarn: (message: string) => void;

  private loaded = false;
  private since = 0;
  private readonly receipts = new Map<string, Receipt>();
  /** 终态 tombstone：即使 active 缓存被 prune，也继续抑制重复事件。 */
  private readonly tombstones = new Map<string, Receipt>();

  constructor(options: ReceiptStoreOptions) {
    this.dir = options.dir;
    this.store = options.store;
    this.dedupeTtlMs = Math.max(
      MIN_DEDUPE_TTL_MS,
      options.dedupeTtlMs ?? DEFAULT_DEDUPE_TTL_MS,
    );
    this.now = options.now ?? Date.now;
    this.onWarn = options.onWarn ?? ((message) => console.warn(message));
  }

  get receiptsSince(): number {
    this.ensureLoaded();
    return this.since;
  }

  get count(): number {
    this.ensureLoaded();
    return new Set([...this.receipts.keys(), ...this.tombstones.keys()]).size;
  }

  get(eventId: string): Receipt | undefined {
    this.ensureLoaded();
    const receipt = this.receipts.get(eventId) ?? this.tombstones.get(eventId);
    return receipt ? cloneReceipt(receipt) : undefined;
  }

  reserve(input: ReserveInput): ReserveResult {
    this.ensureLoaded();

    const existing = this.receipts.get(input.eventId) ?? this.tombstones.get(input.eventId);
    if (existing) {
      return { kind: 'duplicate', receipt: cloneReceipt(existing) };
    }

    const appended = this.store.appendResult({
      id: input.eventId,
      src: 'qq',
      sessionKey: input.sessionKey,
      role: 'user',
      text: input.text,
      speaker: input.speaker,
      quote: input.quote,
      isAtBot: input.isAtBot,
      senderQqId: input.senderQqId,
      modelEligible: input.modelEligible,
      t: input.at,
    });

    if (appended.kind === 'write_error') {
      // 绝不透出 appended.message：底层可能含绝对路径。
      throw new ReceiptStoreError('l0_write_failed', 'L0 写入失败');
    }

    let sessionKey = input.sessionKey;
    if (appended.kind === 'duplicate') {
      const classification = this.classifyExistingRecord(appended.record, input.eventId);
      if (classification.kind === 'ignored') return classification;
      sessionKey = classification.sessionKey;
    }

    const receipt: Receipt = {
      eventId: input.eventId,
      sessionKey,
      status: 'received',
      outcome: null,
      receivedAt: this.now(),
      processingAt: null,
      doneAt: null,
      failureReason: null,
      sentIndexes: null,
      failedIndexes: null,
    };

    this.persistReceipt(receipt);
    this.receipts.set(receipt.eventId, receipt);
    return { kind: 'new', receipt: cloneReceipt(receipt) };
  }

  markProcessing(eventId: string): boolean {
    this.ensureLoaded();
    const current = this.receipts.get(eventId);
    if (!current || current.status !== 'received') return false;
    return this.replaceReceipt({
      ...current,
      status: 'processing',
      processingAt: this.now(),
    });
  }

  markStoredOnly(eventId: string): boolean {
    this.ensureLoaded();
    const current = this.receipts.get(eventId);
    if (!current || current.status !== 'received') return false;
    return this.replaceReceipt({
      ...current,
      status: 'done',
      outcome: 'stored_only',
      doneAt: this.now(),
    });
  }

  markDone(eventId: string, sentIndexes: number[], failedIndexes: number[]): boolean {
    this.ensureLoaded();
    const current = this.receipts.get(eventId);
    if (!current || current.status !== 'processing') return false;
    return this.replaceReceipt({
      ...current,
      status: 'done',
      outcome: 'replied',
      doneAt: this.now(),
      sentIndexes: [...sentIndexes],
      failedIndexes: [...failedIndexes],
    });
  }

  markFailed(eventId: string, reason: string): boolean {
    this.ensureLoaded();
    const current = this.receipts.get(eventId);
    if (!current) return false;
    if (current.status !== 'received' && current.status !== 'processing') return false;
    return this.replaceReceipt({
      ...current,
      status: 'failed',
      outcome: 'failed',
      doneAt: this.now(),
      failureReason: reason,
    });
  }

  bootstrapFromL0(): { recovered: RecoveredReceipt[]; aborted: string[] } {
    this.ensureLoaded();

    const aborted: string[] = [];
    for (const receipt of [...this.receipts.values()]) {
      if (receipt.status !== 'processing') continue;
      const next: Receipt = {
        ...receipt,
        status: 'aborted',
        outcome: 'aborted',
        doneAt: this.now(),
        failureReason: 'aborted_on_restart',
      };
      this.persistReceipt(next);
      this.receipts.set(next.eventId, next);
      this.tombstones.set(next.eventId, next);
      aborted.push(next.eventId);
    }

    const records = new Map<string, RawRecord>();
    for (const month of this.store.listMonths()) {
      for (const record of this.store.readMonth(month)) {
        records.set(record.id, record);
      }
    }

    for (const record of records.values()) {
      if (record.src !== 'qq' || record.role !== 'user') continue;
      const at = Date.parse(record.t);
      if (!Number.isFinite(at) || at < this.since) continue;
      if (this.receipts.has(record.id) || this.tombstones.has(record.id)) continue;

      const receipt: Receipt = {
        eventId: record.id,
        sessionKey: record.sessionKey,
        status: 'received',
        outcome: null,
        receivedAt: at,
        processingAt: null,
        doneAt: null,
        failureReason: null,
        sentIndexes: null,
        failedIndexes: null,
      };
      this.persistReceipt(receipt);
      this.receipts.set(receipt.eventId, receipt);
    }

    const recovered: RecoveredReceipt[] = [];
    for (const receipt of this.receipts.values()) {
      if (receipt.status !== 'received') continue;
      const record = records.get(receipt.eventId);
      if (!record || record.src !== 'qq' || record.role !== 'user') {
        throw new ReceiptStoreError(
          'missing_l0_record',
          'Receipt 为 received 但缺少对应 L0 记录',
        );
      }
      recovered.push({ receipt: cloneReceipt(receipt), record });
    }
    recovered.sort(
      (a, b) =>
        a.receipt.receivedAt - b.receipt.receivedAt ||
        a.receipt.eventId.localeCompare(b.receipt.eventId),
    );

    return { recovered, aborted };
  }

  prune(now: number): void {
    this.ensureLoaded();
    for (const [eventId, receipt] of [...this.receipts]) {
      if (!isTerminal(receipt)) continue;
      const endedAt = receipt.doneAt ?? receipt.receivedAt;
      if (now - endedAt >= this.dedupeTtlMs) {
        this.receipts.delete(eventId);
      }
    }
  }

  private classifyExistingRecord(
    record: RawRecord | undefined,
    eventId: string,
  ):
    | { kind: 'ignored'; reason: 'foreign_l0' | 'before_receipts_since' }
    | { kind: 'recover'; sessionKey: string } {
    if (
      !record ||
      typeof record.id !== 'string' ||
      record.id !== eventId ||
      typeof record.t !== 'string' ||
      typeof record.sessionKey !== 'string' ||
      typeof record.text !== 'string'
    ) {
      throw new ReceiptStoreError('invalid_l0_record', '既有 L0 记录无效');
    }

    const at = Date.parse(record.t);
    if (!Number.isFinite(at)) {
      throw new ReceiptStoreError('invalid_l0_record', '既有 L0 记录时间无效');
    }

    if (record.src === 'cli' || record.role === 'assistant') {
      return { kind: 'ignored', reason: 'foreign_l0' };
    }
    if (record.src !== 'qq' || record.role !== 'user') {
      throw new ReceiptStoreError('invalid_l0_record', '既有 L0 记录无效');
    }

    if (at < this.since) {
      return { kind: 'ignored', reason: 'before_receipts_since' };
    }
    return { kind: 'recover', sessionKey: record.sessionKey };
  }

  private replaceReceipt(next: Receipt): boolean {
    try {
      this.persistReceipt(next);
    } catch {
      this.onWarn('Receipt 写入失败');
      return false;
    }
    this.receipts.set(next.eventId, next);
    if (isTerminal(next)) this.tombstones.set(next.eventId, next);
    return true;
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;

    try {
      const logPath = receiptsLogPath(this.dir);
      let logText: string | null = null;
      if (existsSync(logPath)) {
        try {
          logText = readFileSync(logPath, 'utf8');
        } catch {
          throw new ReceiptStoreError('receipt_read_failed', 'Receipt 读取失败');
        }
      }
      const hadHistory = logText !== null && logText.trim().length > 0;
      this.loadReceipts(logText);
      this.loadOrInitSince(hadHistory);
    } catch (err) {
      this.loaded = false;
      throw err;
    }
  }

  private loadReceipts(text: string | null): void {
    if (text === null) return;
    for (const line of text.split(/\r?\n/)) {
      if (line.trim().length === 0) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }

      const candidate =
        isRecord(value) && value.receipt !== undefined ? value.receipt : value;
      const receipt = parseReceipt(candidate);
      if (!receipt) continue;

      this.receipts.set(receipt.eventId, receipt);
      if (isTerminal(receipt)) {
        this.tombstones.set(receipt.eventId, receipt);
      } else {
        this.tombstones.delete(receipt.eventId);
      }
    }
  }

  private loadOrInitSince(hadHistory: boolean): void {
    const metaPath = receiptsMetaPath(this.dir);
    if (existsSync(metaPath)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(metaPath, 'utf8'));
      } catch {
        throw new ReceiptStoreError('receipts_since_invalid', 'receiptsSince 无效');
      }
      if (
        !isRecord(parsed) ||
        parsed.v !== 1 ||
        typeof parsed.receiptsSince !== 'number' ||
        !Number.isFinite(parsed.receiptsSince)
      ) {
        throw new ReceiptStoreError('receipts_since_invalid', 'receiptsSince 无效');
      }
      this.since = parsed.receiptsSince;
      return;
    }

    if (hadHistory) {
      throw new ReceiptStoreError(
        'receipts_since_missing',
        '已有 Receipt 历史但缺少 receiptsSince',
      );
    }

    const now = this.now();
    this.writeSince({ v: 1, receiptsSince: now });
    this.since = now;
  }

  private writeSince(meta: ReceiptMeta): void {
    const metaPath = receiptsMetaPath(this.dir);
    const tempPath = `${metaPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(tempPath, `${JSON.stringify(meta)}\n`, 'utf8');
      renameSync(tempPath, metaPath);
    } catch {
      try {
        rmSync(tempPath, { force: true });
      } catch {
        // 忽略临时文件清理失败
      }
      throw new ReceiptStoreError(
        'receipts_since_write_failed',
        'receiptsSince 写入失败',
      );
    }
  }

  private persistReceipt(receipt: Receipt): void {
    const line: ReceiptLine = { v: 1, receipt };
    try {
      mkdirSync(this.dir, { recursive: true });
      appendFileSync(receiptsLogPath(this.dir), `${JSON.stringify(line)}\n`, 'utf8');
    } catch {
      throw new ReceiptStoreError('receipt_write_failed', 'Receipt 写入失败');
    }
  }
}
