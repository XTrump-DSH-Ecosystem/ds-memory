import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EventStore,
  type AppendInput,
  type AppendResult,
  type RawRecord,
} from '../../src/memory/store.ts';
import {
  ReceiptStore,
  ReceiptStoreError,
  receiptsLogPath,
  receiptsMetaPath,
  type ReceiptStoreOptions,
} from '../../src/qq/receipts.ts';
import type { Receipt, ReserveInput, ReserveResult } from '../../src/qq/types.ts';

const NOW = 1_700_000_000_000;

let rootDir: string;
let eventsDir: string;
let receiptDir: string;
let clock: number;
let warnings: string[];
let store: EventStore;

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'xds-receipts-'));
  eventsDir = join(rootDir, 'memory', 'events');
  receiptDir = join(rootDir, 'qq');
  clock = NOW;
  warnings = [];
  store = makeEventStore();
});

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

function makeEventStore(): EventStore {
  return new EventStore({
    dir: eventsDir,
    now: () => clock,
    onWarn: (message) => warnings.push(message),
  });
}

function makeReceipts(
  options: Partial<Omit<ReceiptStoreOptions, 'dir' | 'store'>> & {
    store?: EventStore;
  } = {},
): ReceiptStore {
  return new ReceiptStore({
    dir: receiptDir,
    store: options.store ?? store,
    now: options.now ?? (() => clock),
    onWarn: options.onWarn ?? ((message) => warnings.push(message)),
    dedupeTtlMs: options.dedupeTtlMs,
  });
}

function reserveInput(overrides: Partial<ReserveInput> = {}): ReserveInput {
  return {
    eventId: 'evt:10001:message:3589',
    sessionKey: 'private:123456789',
    role: 'user',
    text: '在吗',
    speaker: null,
    quote: null,
    isAtBot: false,
    senderQqId: '123456789',
    modelEligible: true,
    at: NOW,
    ...overrides,
  };
}

function expectNew(result: ReserveResult): Extract<ReserveResult, { kind: 'new' }> {
  expect(result.kind).toBe('new');
  if (result.kind !== 'new') throw new Error(`expected new, got ${result.kind}`);
  return result;
}

function expectDuplicate(
  result: ReserveResult,
): Extract<ReserveResult, { kind: 'duplicate' }> {
  expect(result.kind).toBe('duplicate');
  if (result.kind !== 'duplicate') {
    throw new Error(`expected duplicate, got ${result.kind}`);
  }
  return result;
}

function allL0(): RawRecord[] {
  const diskStore = new EventStore({ dir: eventsDir, onWarn: () => undefined });
  return diskStore.listMonths().flatMap((month) => diskStore.readMonth(month));
}

function receiptLines(): Array<{ v: number; receipt: Receipt }> {
  const path = receiptsLogPath(receiptDir);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { v: number; receipt: Receipt });
}

function expectReceiptError(
  fn: () => unknown,
  code: ReceiptStoreError['code'],
): ReceiptStoreError {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(ReceiptStoreError);
  const error = caught as ReceiptStoreError;
  expect(error.code).toBe(code);
  return error;
}

class StubStore extends EventStore {
  private readonly result: AppendResult;
  private readonly records: RawRecord[];

  constructor(dir: string, result: AppendResult, records: RawRecord[] = []) {
    super({ dir, onWarn: () => undefined });
    this.result = result;
    this.records = records;
  }

  override appendResult(_input: AppendInput): AppendResult {
    return this.result;
  }

  override listMonths(): string[] {
    return this.records.length > 0 ? ['stub'] : [];
  }

  override readMonth(_month: string): RawRecord[] {
    return this.records;
  }
}

class ProbeStore extends EventStore {
  metaExistedDuringScan: boolean | null = null;

  override listMonths(): string[] {
    this.metaExistedDuringScan = existsSync(receiptsMetaPath(receiptDir));
    return super.listMonths();
  }
}

describe('ReceiptStore.reserve', () => {
  it('inserted 时写完整 L0 与 received，并返回 new', () => {
    const receipts = makeReceipts();

    const result = expectNew(
      receipts.reserve(
        reserveInput({
          sessionKey: 'group:555000111',
          text: '@小鲸鱼 帮我看下 4090',
          speaker: '张三',
          quote: { fromName: '李四', text: '上次说的 4090' },
          isAtBot: true,
        }),
      ),
    );

    expect(result.receipt).toMatchObject({
      eventId: 'evt:10001:message:3589',
      sessionKey: 'group:555000111',
      status: 'received',
      outcome: null,
      receivedAt: NOW,
      processingAt: null,
      doneAt: null,
      failureReason: null,
      sentIndexes: null,
      failedIndexes: null,
    });

    const records = allL0();
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual({
      id: 'evt:10001:message:3589',
      src: 'qq',
      sessionKey: 'group:555000111',
      t: new Date(NOW).toISOString(),
      role: 'user',
      text: '@小鲸鱼 帮我看下 4090',
      speaker: '张三',
      quote: { fromName: '李四', text: '上次说的 4090' },
      isAtBot: true,
      senderQqId: '123456789',
      modelEligible: true,
    });
    expect(receiptLines()).toEqual([{ v: 1, receipt: result.receipt }]);
  });

  it('reserve 透传 senderQqId 与 modelEligible 到 L0', () => {
    const receipts = makeReceipts();

    const result = expectNew(
      receipts.reserve(
        reserveInput({
          eventId: 'evt:group-member',
          sessionKey: 'group:555000111',
          text: '普通群友原文',
          senderQqId: '222333444',
          modelEligible: false,
        }),
      ),
    );

    expect(result.receipt.sessionKey).toBe('group:555000111');
    const [record] = allL0();
    expect(record).toMatchObject({
      id: 'evt:group-member',
      senderQqId: '222333444',
      modelEligible: false,
      text: '普通群友原文',
    });
  });

  it('Receipt 已存在时返回 duplicate，不重写 L0/Receipt', () => {
    const receipts = makeReceipts();
    const first = expectNew(receipts.reserve(reserveInput()));

    const duplicate = expectDuplicate(
      receipts.reserve(reserveInput({ text: '不应覆盖的第二次正文' })),
    );

    expect(duplicate.receipt).toEqual(first.receipt);
    expect(allL0()).toHaveLength(1);
    expect(allL0()[0]?.text).toBe('在吗');
    expect(receiptLines()).toHaveLength(1);
  });

  it('L0 已有可恢复 QQ user 记录时只补建一次 received', () => {
    makeReceipts().receiptsSince;
    clock = NOW + 5_000;
    const seeded = reserveInput({
      eventId: 'evt:recover',
      sessionKey: 'group:seed-session',
      text: 'L0 已落盘',
      at: NOW + 1_000,
    });
    expect(
      store.appendResult({
        id: seeded.eventId,
        src: 'qq',
        sessionKey: seeded.sessionKey,
        role: 'user',
        text: seeded.text,
        t: seeded.at,
      }).kind,
    ).toBe('inserted');

    const restarted = makeReceipts();
    const recovered = expectNew(
      restarted.reserve({ ...seeded, sessionKey: 'private:different' }),
    );

    expect(recovered.receipt).toMatchObject({
      eventId: 'evt:recover',
      sessionKey: 'group:seed-session',
      status: 'received',
      receivedAt: NOW + 5_000,
    });
    expect(allL0()).toHaveLength(1);
    expect(receiptLines()).toHaveLength(1);
    expectDuplicate(restarted.reserve(seeded));
  });

  it.each([
    ['CLI user', 'cli', 'user', 'foreign_l0'],
    ['QQ assistant', 'qq', 'assistant', 'foreign_l0'],
  ] as const)(
    '既有 L0 为 %s 时返回 ignored，且不建 Receipt',
    (_label, src, role, reason) => {
      const receiptStore = makeReceipts();
      receiptStore.receiptsSince;

      clock = NOW + 1_000;
      expect(
        store.appendResult({
          id: 'evt:foreign',
          src,
          sessionKey: 'private:1',
          role,
          text: '已有其他来源记录',
          t: clock,
        }).kind,
      ).toBe('inserted');

      const result = receiptStore.reserve(
        reserveInput({ eventId: 'evt:foreign', at: clock }),
      );

      expect(result).toEqual({ kind: 'ignored', reason });
      expect(receiptStore.get('evt:foreign')).toBeUndefined();
      expect(receiptLines()).toHaveLength(0);
      expect(allL0()).toHaveLength(1);
    },
  );

  it('既有 QQ user L0 早于 receiptsSince 时返回 ignored', () => {
    const receiptStore = makeReceipts();
    expect(receiptStore.receiptsSince).toBe(NOW);

    expect(
      store.appendResult({
        id: 'evt:before',
        src: 'qq',
        sessionKey: 'private:1',
        role: 'user',
        text: '水位前旧消息',
        t: NOW - 1,
      }).kind,
    ).toBe('inserted');

    const restarted = makeReceipts();
    expect(
      restarted.reserve(reserveInput({ eventId: 'evt:before', at: NOW - 1 })),
    ).toEqual({ kind: 'ignored', reason: 'before_receipts_since' });
    expect(restarted.get('evt:before')).toBeUndefined();
    expect(receiptLines()).toHaveLength(0);
    expect(allL0()).toHaveLength(1);
  });

  it('duplicate 返回的 L0 记录缺失或 t 无法解析时抛错，不 ACK 不确定状态', () => {
    const missingRecord = {
      kind: 'duplicate',
    } as unknown as AppendResult;
    const missingStore = new StubStore(eventsDir, missingRecord);
    expectReceiptError(
      () => makeReceipts({ store: missingStore }).reserve(reserveInput()),
      'invalid_l0_record',
    );

    const badTime: RawRecord = {
      id: 'evt:10001:message:3589',
      src: 'qq',
      sessionKey: 'private:123456789',
      t: 'not-a-date',
      role: 'user',
      text: '在吗',
    };
    const badTimeStore = new StubStore(eventsDir, {
      kind: 'duplicate',
      record: badTime,
    });
    expectReceiptError(
      () => makeReceipts({ store: badTimeStore }).reserve(reserveInput()),
      'invalid_l0_record',
    );

    const badText: RawRecord = {
      id: 'evt:10001:message:3589',
      src: 'qq',
      sessionKey: 'private:123456789',
      t: new Date(NOW).toISOString(),
      role: 'user',
      text: 123 as unknown as string,
    };
    const badTextStore = new StubStore(eventsDir, {
      kind: 'duplicate',
      record: badText,
    });
    expectReceiptError(
      () => makeReceipts({ store: badTextStore }).reserve(reserveInput()),
      'invalid_l0_record',
    );
  });

  it('write_error 只抛固定脱敏错误，不泄漏底层路径', () => {
    const stub = new StubStore(eventsDir, {
      kind: 'write_error',
      message: 'C:\\secret\\memory\\events\\2026-11.jsonl /tmp/private/events',
    });
    const receipts = makeReceipts({ store: stub });

    const error = expectReceiptError(
      () => receipts.reserve(reserveInput()),
      'l0_write_failed',
    );

    expect(error.message).toBe('L0 写入失败');
    expect(error.message).not.toContain('C:\\');
    expect(error.message).not.toContain('/tmp');
    expect(warnings).toEqual([]);
    expect(receipts.get(reserveInput().eventId)).toBeUndefined();
    expect(receiptLines()).toHaveLength(0);
  });
});

describe('ReceiptStore state machine', () => {
  it('received → processing → done(replied)', () => {
    clock = NOW;
    const receipts = makeReceipts();
    receipts.reserve(reserveInput());

    clock = NOW + 10;
    expect(receipts.markProcessing('evt:10001:message:3589')).toBe(true);
    expect(receipts.get('evt:10001:message:3589')).toMatchObject({
      status: 'processing',
      processingAt: NOW + 10,
    });

    clock = NOW + 20;
    expect(
      receipts.markDone('evt:10001:message:3589', [0, 2], [1]),
    ).toBe(true);
    expect(receipts.get('evt:10001:message:3589')).toEqual({
      eventId: 'evt:10001:message:3589',
      sessionKey: 'private:123456789',
      status: 'done',
      outcome: 'replied',
      receivedAt: NOW,
      processingAt: NOW + 10,
      doneAt: NOW + 20,
      failureReason: null,
      sentIndexes: [0, 2],
      failedIndexes: [1],
    });
    expect(receipts.markFailed('evt:10001:message:3589', 'late')).toBe(false);
    expect(receipts.markProcessing('evt:10001:message:3589')).toBe(false);
  });

  it('received → done(stored_only)，终态不自动重试', () => {
    const receipts = makeReceipts();
    receipts.reserve(reserveInput({ eventId: 'evt:stored-only' }));

    expect(receipts.markStoredOnly('evt:stored-only')).toBe(true);
    expect(receipts.get('evt:stored-only')).toMatchObject({
      status: 'done',
      outcome: 'stored_only',
      doneAt: NOW,
    });
    expect(receipts.markProcessing('evt:stored-only')).toBe(false);
    expect(receipts.markDone('evt:stored-only', [], [])).toBe(false);
  });

  it('received 可直接 failed，并记录调用方错误原因', () => {
    const receipts = makeReceipts();
    receipts.reserve(reserveInput({ eventId: 'evt:failed' }));

    expect(receipts.markFailed('evt:failed', 'model_failed')).toBe(true);
    expect(receipts.get('evt:failed')).toMatchObject({
      status: 'failed',
      outcome: 'failed',
      doneAt: NOW,
      failureReason: 'model_failed',
    });
    expect(receipts.markStoredOnly('evt:failed')).toBe(false);
  });

  it('重启把遗留 processing 置 aborted，且不进入 recovered', () => {
    const receipts = makeReceipts();
    receipts.reserve(reserveInput({ eventId: 'evt:processing' }));
    expect(receipts.markProcessing('evt:processing')).toBe(true);

    clock = NOW + 100;
    const restarted = makeReceipts();
    expect(restarted.bootstrapFromL0()).toEqual({
      recovered: [],
      aborted: ['evt:processing'],
    });
    expect(restarted.get('evt:processing')).toMatchObject({
      status: 'aborted',
      outcome: 'aborted',
      doneAt: NOW + 100,
      failureReason: 'aborted_on_restart',
    });

    const again = makeReceipts();
    expect(again.bootstrapFromL0()).toEqual({ recovered: [], aborted: [] });
    expect(again.get('evt:processing')?.status).toBe('aborted');
  });

  it('received 跨重启恢复一次，之后重复仍为 duplicate', () => {
    const receipts = makeReceipts();
    receipts.reserve(reserveInput({ eventId: 'evt:received' }));

    const restarted = makeReceipts();
    const boot = restarted.bootstrapFromL0();
    expect(boot.aborted).toEqual([]);
    expect(boot.recovered).toHaveLength(1);
    expect(boot.recovered[0]?.receipt).toMatchObject({
      eventId: 'evt:received',
      status: 'received',
    });
    expect(boot.recovered[0]?.record.id).toBe('evt:received');

    expectDuplicate(
      restarted.reserve(reserveInput({ eventId: 'evt:received' })),
    );
    expect(allL0()).toHaveLength(1);
    expect(receiptLines()).toHaveLength(1);
  });

  it('pending received 不被 prune 丢弃', () => {
    const receipts = makeReceipts();
    receipts.reserve(reserveInput({ eventId: 'evt:pending' }));

    receipts.prune(NOW + 10 * 365 * 24 * 60 * 60 * 1_000);
    expect(receipts.get('evt:pending')?.status).toBe('received');
    expect(makeReceipts().bootstrapFromL0().recovered).toHaveLength(1);
  });

  it('终态 tombstone 在 prune、重启与运行时重复下均持续抑制', () => {
    const receipts = makeReceipts();
    receipts.reserve(reserveInput({ eventId: 'evt:done' }));
    receipts.markProcessing('evt:done');
    clock = NOW + 30;
    receipts.markDone('evt:done', [0], []);
    const beforePrune = receiptLines().length;

    clock = NOW + 30 + 400_000;
    receipts.prune(clock);
    expect(receipts.get('evt:done')?.status).toBe('done');

    const restarted = makeReceipts();
    expect(restarted.bootstrapFromL0().recovered).toEqual([]);
    const duplicate = expectDuplicate(
      restarted.reserve(reserveInput({ eventId: 'evt:done' })),
    );
    expect(duplicate.receipt.status).toBe('done');
    expect(allL0()).toHaveLength(1);
    expect(receiptLines()).toHaveLength(beforePrune);
  });
});

describe('ReceiptStore bootstrapFromL0', () => {
  it('首次启用水位先于 L0 扫描落盘，且重启不重置', () => {
    const probeStore = new ProbeStore({ dir: eventsDir });
    const receipts = makeReceipts({ store: probeStore });

    expect(receipts.receiptsSince).toBe(NOW);
    expect(receipts.bootstrapFromL0()).toEqual({ recovered: [], aborted: [] });
    expect(probeStore.metaExistedDuringScan).toBe(true);

    const meta = JSON.parse(readFileSync(receiptsMetaPath(receiptDir), 'utf8')) as {
      v: number;
      receiptsSince: number;
    };
    expect(meta).toEqual({ v: 1, receiptsSince: NOW });

    clock = NOW + 99_999;
    expect(makeReceipts().receiptsSince).toBe(NOW);
  });

  it('已有 Receipt 历史但缺水位时启动失败，不猜测', () => {
    const receipts = makeReceipts();
    receipts.reserve(reserveInput());
    expect(receiptLines()).toHaveLength(1);

    rmSync(receiptsMetaPath(receiptDir));
    expectReceiptError(
      () => makeReceipts().receiptsSince,
      'receipts_since_missing',
    );
  });

  it('水位文件损坏时启动失败', () => {
    mkdirSync(receiptDir, { recursive: true });
    writeFileSync(receiptsMetaPath(receiptDir), '{not-json', 'utf8');
    expectReceiptError(
      () => makeReceipts().receiptsSince,
      'receipts_since_invalid',
    );

    writeFileSync(
      receiptsMetaPath(receiptDir),
      JSON.stringify({ v: 1, receiptsSince: 'yesterday' }),
      'utf8',
    );
    expectReceiptError(
      () => makeReceipts().receiptsSince,
      'receipts_since_invalid',
    );
  });

  it('Receipt 日志不可读时启动失败，不按空 tombstone 集继续', () => {
    mkdirSync(receiptsLogPath(receiptDir), { recursive: true });

    const error = expectReceiptError(
      () => makeReceipts().receiptsSince,
      'receipt_read_failed',
    );
    expect(error.message).toBe('Receipt 读取失败');
    expect(error.message).not.toContain(rootDir);
  });

  it('状态目录不可用时首次水位写入失败使用固定错误', () => {
    const blockedPath = join(rootDir, 'blocked-state');
    writeFileSync(blockedPath, 'not a directory', 'utf8');
    receiptDir = blockedPath;

    const error = expectReceiptError(
      () => makeReceipts().receiptsSince,
      'receipts_since_write_failed',
    );
    expect(error.message).toBe('receiptsSince 写入失败');
    expect(error.message).not.toContain(blockedPath);
  });

  it('只恢复 qq/user/水位后记录，按 receivedAt 排序，CLI 与 assistant 永不回放', () => {
    const receipts = makeReceipts();
    expect(receipts.receiptsSince).toBe(NOW);

    const seeded: Array<{
      id: string;
      src: 'qq' | 'cli';
      role: 'user' | 'assistant';
      at: number;
    }> = [
      { id: 'evt:old', src: 'qq', role: 'user', at: NOW - 1 },
      { id: 'evt:new-later', src: 'qq', role: 'user', at: NOW + 200 },
      { id: 'evt:new-earlier', src: 'qq', role: 'user', at: NOW + 100 },
      { id: 'evt:cli', src: 'cli', role: 'user', at: NOW + 150 },
      { id: 'evt:assistant', src: 'qq', role: 'assistant', at: NOW + 250 },
    ];
    for (const item of seeded) {
      expect(
        store.appendResult({
          id: item.id,
          src: item.src,
          sessionKey: 'private:1',
          role: item.role,
          text: item.id,
          t: item.at,
        }).kind,
      ).toBe('inserted');
    }

    const boot = makeReceipts().bootstrapFromL0();
    expect(boot.aborted).toEqual([]);
    expect(boot.recovered.map((item) => item.receipt.eventId)).toEqual([
      'evt:new-earlier',
      'evt:new-later',
    ]);
    expect(boot.recovered.map((item) => item.receipt.receivedAt)).toEqual([
      NOW + 100,
      NOW + 200,
    ]);
    expect(receiptLines()).toHaveLength(2);
    expect(allL0()).toHaveLength(seeded.length);
  });

  it('received 找不到对应 qq/user L0 时启动失败', () => {
    const receipts = makeReceipts();
    receipts.reserve(reserveInput({ eventId: 'evt:orphan' }));
    rmSync(eventsDir, { recursive: true, force: true });

    const restarted = makeReceipts({
      store: new EventStore({ dir: eventsDir, onWarn: () => undefined }),
    });
    expectReceiptError(() => restarted.bootstrapFromL0(), 'missing_l0_record');
  });

  it('坏 Receipt 行跳过，合法终态仍作为 tombstone 加载', () => {
    mkdirSync(receiptDir, { recursive: true });
    makeReceipts().receiptsSince;
    const done: Receipt = {
      eventId: 'evt:terminal',
      sessionKey: 'private:1',
      status: 'done',
      outcome: 'replied',
      receivedAt: NOW,
      processingAt: NOW,
      doneAt: NOW,
      failureReason: null,
      sentIndexes: [0],
      failedIndexes: [],
    };
    writeFileSync(
      receiptsLogPath(receiptDir),
      `{broken\n${JSON.stringify({ v: 1, receipt: done })}\n`,
      'utf8',
    );

    const restarted = makeReceipts();
    expect(restarted.get('evt:terminal')).toEqual(done);
    expect(restarted.bootstrapFromL0()).toEqual({ recovered: [], aborted: [] });
  });
});
