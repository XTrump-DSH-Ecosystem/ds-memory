import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Agent } from '../../src/agent/loop.ts';
import { EventStore } from '../../src/memory/store.ts';
import { AgentRegistry } from '../../src/qq/agent-registry.ts';
import { runQqTurn } from '../../src/qq/turn.ts';
import type {
  QqSendOptions,
  QqSender,
  QqSenderRole,
  QqTarget,
  ReceiptStore,
  SendResult,
  WakePacket,
} from '../../src/qq/types.ts';
import {
  usageOfEvent,
  type ChatEvent,
  type ChatEventStream,
  type ChatRequest,
  type Provider,
} from '../../src/provider/types.ts';

const NOW = 1_700_000_000_000;
const SESSION = 'private:1';
const TARGET: QqTarget = { kind: 'private', id: '10001' };

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'xds-turn-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function providerReturning(
  text: string,
  input: {
    calls?: ChatRequest[];
    timeline?: string[];
    label?: string;
  } = {},
): Provider {
  return {
    id: 'deepseek',
    chat(req): ChatEventStream {
      input.calls?.push(req);
      input.timeline?.push(input.label ?? 'provider');
      return (async function* (): AsyncGenerator<ChatEvent> {
        if (text.length > 0) yield { type: 'text', text };
        yield { type: 'done' };
      })();
    },
    usageOf: usageOfEvent,
    async health() {
      return { ok: true, detail: 'fake' };
    },
  };
}

interface ReceiptEvent {
  type: 'processing' | 'done' | 'failed';
  eventId: string;
  sentIndexes?: number[];
  failedIndexes?: number[];
  reason?: string;
}

function makeReceipts(
  options: {
    processingFails?: readonly string[];
    markFailedThrows?: boolean;
    timeline?: string[];
  } = {},
): { receipts: ReceiptStore; events: ReceiptEvent[] } {
  const events: ReceiptEvent[] = [];
  const failures = new Set(options.processingFails ?? []);

  const receipts: ReceiptStore = {
    reserve() {
      throw new Error('T4c 不应调用 reserve');
    },
    markProcessing(eventId) {
      options.timeline?.push(`processing:${eventId}`);
      events.push({ type: 'processing', eventId });
      return !failures.has(eventId);
    },
    markStoredOnly() {
      return true;
    },
    markDone(eventId, sentIndexes, failedIndexes) {
      options.timeline?.push(`done:${eventId}`);
      events.push({
        type: 'done',
        eventId,
        sentIndexes: [...sentIndexes],
        failedIndexes: [...failedIndexes],
      });
      return true;
    },
    markFailed(eventId, reason) {
      if (options.markFailedThrows) throw new Error('receipt write failed');
      options.timeline?.push(`failed:${eventId}`);
      events.push({ type: 'failed', eventId, reason });
      return true;
    },
    bootstrapFromL0() {
      return { recovered: [], aborted: [] };
    },
    prune() {},
  };

  return { receipts, events };
}

interface SenderCall {
  target: QqTarget;
  messages: string[];
  opts: QqSendOptions | undefined;
}

function senderReturning(
  handler: (messages: string[]) => SendResult | Promise<SendResult>,
  timeline?: string[],
): { sender: QqSender; calls: SenderCall[] } {
  const calls: SenderCall[] = [];
  return {
    calls,
    sender: {
      async send(target, messages, opts) {
        calls.push({ target, messages: [...messages], opts });
        timeline?.push('send');
        return handler([...messages]);
      },
    },
  };
}

function allSent(count: number): SendResult {
  return {
    outcome: 'all_sent',
    sentIndexes: Array.from({ length: count }, (_, index) => index),
    failedIndexes: [],
    retryable: false,
    retryAfterMs: null,
    reason: null,
  };
}

function sendResultOf(
  overrides: Partial<SendResult> & Pick<SendResult, 'outcome'>,
): SendResult {
  return {
    outcome: overrides.outcome,
    sentIndexes: overrides.sentIndexes ?? [],
    failedIndexes: overrides.failedIndexes ?? [],
    retryable: overrides.retryable ?? false,
    retryAfterMs: overrides.retryAfterMs ?? null,
    reason: overrides.reason ?? null,
  };
}

function wakeOf(
  eventIds: readonly string[],
  modelText = '合并后的模型输入',
  sessionKey = SESSION,
  senderRole: QqSenderRole = 'owner',
  origin: 'live' | 'recovered' = 'live',
): WakePacket {
  return {
    sessionKey,
    items: eventIds.map((eventId, index) => ({
      eventId,
      speaker: null,
      senderRole,
      origin,
      quote: null,
      text: `原文-${eventId}`,
      at: NOW + index,
    })),
    omittedEventIds: ['omitted-event'],
    modelText,
    totalChars: modelText.length,
    truncatedCount: 0,
  };
}

function makeRegistry(
  store: EventStore,
  providerFor: (sessionKey: string) => Provider,
): AgentRegistry {
  return new AgentRegistry({
    createAgent: (sessionKey) =>
      new Agent({
        provider: providerFor(sessionKey),
        store,
        persona: '测试人设',
        sessionKey,
        src: 'qq',
        now: () => NOW,
      }),
  });
}

function seedUsers(store: EventStore, eventIds: readonly string[], sessionKey = SESSION): void {
  for (const [index, eventId] of eventIds.entries()) {
    store.append({
      id: eventId,
      src: 'qq',
      sessionKey,
      role: 'user',
      text: `原文-${eventId}`,
      t: NOW + index,
    });
  }
}

function records(store: EventStore) {
  return store.readMonth('2023-11');
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

async function runTurnWithSendResult(sendResult: SendResult) {
  const store = new EventStore({ dir: join(dir, 'events'), now: () => NOW });
  seedUsers(store, ['e1', 'e2']);

  const provider = providerReturning('一。二。');
  const registry = makeRegistry(store, () => provider);
  const { receipts, events } = makeReceipts();
  const { sender, calls } = senderReturning(() => sendResult);

  const result = await runQqTurn({
    registry,
    sessionKey: SESSION,
    wake: wakeOf(['e1', 'e2']),
    sender,
    receipts,
    target: TARGET,
    maxPerTurn: 3,
    signal: signal(),
  });

  return { result, events, store, calls };
}

describe('runQqTurn', () => {
  it('全成功：processing → provider → send → 仅送达内容落 L0 → done', async () => {
    const store = new EventStore({ dir: join(dir, 'events'), now: () => NOW });
    seedUsers(store, ['e1', 'e2']);

    const timeline: string[] = [];
    const requests: ChatRequest[] = [];
    const reply = Array.from({ length: 10 }, (_, index) => `第${index + 1}句。`).join('');
    const provider = providerReturning(reply, { calls: requests, timeline });
    const registry = makeRegistry(store, () => provider);
    const { receipts, events } = makeReceipts({ timeline });
    const { sender, calls: senderCalls } = senderReturning(() => allSent(1), timeline);
    const abort = signal();

    const result = await runQqTurn({
      registry,
      sessionKey: SESSION,
      wake: wakeOf(['e1', 'e2'], '模型输入原文'),
      sender,
      receipts,
      target: TARGET,
      maxPerTurn: 3,
      signal: abort,
    });

    expect(result.plan.messages).toEqual([reply]);
    expect(result.deliveredText).toBe(reply);
    expect(result.sendResult?.outcome).toBe('all_sent');

    // markProcessing 在 provider 之前，commit 在 markDone 之前。
    expect(timeline).toEqual([
      'processing:e1',
      'processing:e2',
      'provider',
      'send',
      'done:e1',
      'done:e2',
    ]);
    expect(requests[0]!.messages.at(-1)!.content.endsWith('模型输入原文')).toBe(true);

    const all = records(store);
    expect(all.filter((record) => record.role === 'user').map((record) => record.id)).toEqual([
      'e1',
      'e2',
    ]);
    expect(
      all.filter((record) => record.role === 'assistant').map((record) => record.text),
    ).toEqual([reply]);

    expect(senderCalls).toHaveLength(1);
    expect(senderCalls[0]!.target).toBe(TARGET);
    expect(senderCalls[0]!.messages).toEqual([reply]);
    expect(senderCalls[0]!.opts?.signal).toBe(abort);

    expect(events.filter((event) => event.type === 'done')).toEqual([
      { type: 'done', eventId: 'e1', sentIndexes: [0], failedIndexes: [] },
      { type: 'done', eventId: 'e2', sentIndexes: [0], failedIndexes: [] },
    ]);
    expect(events.some((event) => event.eventId === 'omitted-event')).toBe(false);
    expect(registry.get(SESSION)!.historyMessageCount).toBe(2);
  });

  it('部分成功：只提交 sentIndexes 对应内容，按原序，标记 done', async () => {
    const store = new EventStore({ dir: join(dir, 'events'), now: () => NOW });
    seedUsers(store, ['e1', 'e2']);

    const chunks = [`${'一'.repeat(2901)}。`, '三'.repeat(200)];
    const provider = providerReturning(chunks.join(''));
    const registry = makeRegistry(store, () => provider);
    const { receipts, events } = makeReceipts();
    const { sender, calls } = senderReturning(() =>
      sendResultOf({
        outcome: 'partial',
        sentIndexes: [1],
        failedIndexes: [0],
        reason: '部分失败',
      }),
    );

    const result = await runQqTurn({
      registry,
      sessionKey: SESSION,
      wake: wakeOf(['e1']),
      sender,
      receipts,
      target: TARGET,
      maxPerTurn: 3,
      signal: signal(),
    });

    expect(result.plan.messages).toEqual(chunks);
    expect(result.deliveredText).toBe(chunks[1]);
    expect(calls).toHaveLength(1);

    const assistant = records(store).filter((record) => record.role === 'assistant');
    expect(assistant.map((record) => record.text)).toEqual([chunks[1]!]);
    expect(assistant[0]!.text).not.toContain('一'.repeat(2900));

    expect(events.filter((event) => event.type === 'done')).toEqual([
      { type: 'done', eventId: 'e1', sentIndexes: [1], failedIndexes: [0] },
    ]);
    expect(events.some((event) => event.type === 'failed')).toBe(false);
  });

  it('零送达：不写 assistant，标记 failed，不重试', async () => {
    const store = new EventStore({ dir: join(dir, 'events'), now: () => NOW });
    seedUsers(store, ['e1']);

    const provider = providerReturning('一。二。');
    const registry = makeRegistry(store, () => provider);
    const { receipts, events } = makeReceipts();
    const { sender, calls } = senderReturning(() =>
      sendResultOf({
        outcome: 'none_sent',
        failedIndexes: [0],
        reason: '额度不足',
      }),
    );

    const result = await runQqTurn({
      registry,
      sessionKey: SESSION,
      wake: wakeOf(['e1']),
      sender,
      receipts,
      target: TARGET,
      maxPerTurn: 3,
      signal: signal(),
    });

    expect(result.deliveredText).toBe('');
    expect(calls).toHaveLength(1);
    expect(records(store).filter((record) => record.role === 'assistant')).toEqual([]);
    expect(events.filter((event) => event.type === 'done')).toEqual([]);
    expect(events.filter((event) => event.type === 'failed')).toEqual([
      { type: 'failed', eventId: 'e1', reason: '额度不足' },
    ]);
  });

  it('歧义失败即使带 sentIndexes 也不写 assistant，标记 failed', async () => {
    const store = new EventStore({ dir: join(dir, 'events'), now: () => NOW });
    seedUsers(store, ['e1']);

    const provider = providerReturning('一。二。');
    const registry = makeRegistry(store, () => provider);
    const { receipts, events } = makeReceipts();
    const { sender } = senderReturning(() =>
      sendResultOf({
        outcome: 'ambiguous_failure',
        sentIndexes: [0],
        failedIndexes: [],
        reason: '响应非法',
      }),
    );

    const result = await runQqTurn({
      registry,
      sessionKey: SESSION,
      wake: wakeOf(['e1']),
      sender,
      receipts,
      target: TARGET,
      maxPerTurn: 3,
      signal: signal(),
    });

    expect(result.deliveredText).toBe('');
    expect(records(store).filter((record) => record.role === 'assistant')).toEqual([]);
    expect(events.filter((event) => event.type === 'done')).toEqual([]);
    expect(events.filter((event) => event.type === 'failed')).toEqual([
      { type: 'failed', eventId: 'e1', reason: '响应非法' },
    ]);
  });

  it('合法 ambiguous 允许并集不完整，仍按零送达处理', async () => {
    const senderResult = sendResultOf({
      outcome: 'ambiguous_failure',
      sentIndexes: [0],
      failedIndexes: [],
      reason: '响应非法',
    });

    const { result, events, store, calls } = await runTurnWithSendResult(senderResult);

    expect(result.sendResult).toEqual(senderResult);
    expect(result.deliveredText).toBe('');
    expect(calls).toHaveLength(1);
    expect(records(store).filter((record) => record.role === 'assistant')).toEqual([]);
    expect(events.filter((event) => event.type === 'done')).toEqual([]);
    expect(events.filter((event) => event.type === 'failed')).toEqual([
      { type: 'failed', eventId: 'e1', reason: '响应非法' },
      { type: 'failed', eventId: 'e2', reason: '响应非法' },
    ]);
  });

  describe('SendResult index 不变量本地校验', () => {
    const invalidResults: Array<[string, SendResult]> = [
      [
        'sentIndexes 重复',
        sendResultOf({ outcome: 'all_sent', sentIndexes: [0, 0], failedIndexes: [] }),
      ],
      [
        'failedIndexes 重复',
        sendResultOf({ outcome: 'none_sent', sentIndexes: [], failedIndexes: [0, 0] }),
      ],
      [
        'sentIndex 越界',
        sendResultOf({ outcome: 'all_sent', sentIndexes: [0, 2], failedIndexes: [] }),
      ],
      [
        'failedIndex 越界',
        sendResultOf({ outcome: 'none_sent', sentIndexes: [], failedIndexes: [0, 2] }),
      ],
      [
        '非整数 index',
        sendResultOf({ outcome: 'all_sent', sentIndexes: [0, 1.5], failedIndexes: [] }),
      ],
      [
        '两个数组交叉重叠',
        sendResultOf({ outcome: 'partial', sentIndexes: [0], failedIndexes: [0, 1] }),
      ],
      [
        '非 ambiguous 漏 index',
        sendResultOf({ outcome: 'partial', sentIndexes: [0], failedIndexes: [] }),
      ],
      [
        'all_sent 但 failed 非空',
        sendResultOf({ outcome: 'all_sent', sentIndexes: [0], failedIndexes: [1] }),
      ],
      [
        'partial 但 failed 为空',
        sendResultOf({ outcome: 'partial', sentIndexes: [0, 1], failedIndexes: [] }),
      ],
      [
        'partial 但 sent 为空',
        sendResultOf({ outcome: 'partial', sentIndexes: [], failedIndexes: [0, 1] }),
      ],
      [
        'none_sent 但 sent 非空',
        sendResultOf({ outcome: 'none_sent', sentIndexes: [0], failedIndexes: [1] }),
      ],
      [
        'ambiguous 但 index 重复',
        sendResultOf({
          outcome: 'ambiguous_failure',
          sentIndexes: [0, 0],
          failedIndexes: [],
        }),
      ],
      ['未知 outcome', { ...allSent(2), outcome: 'bogus' as SendResult['outcome'] }],
      [
        '非数组 sentIndexes',
        { ...allSent(2), sentIndexes: '0,1' as unknown as number[] },
      ],
    ];

    it.each(invalidResults)('%s：归一化为 ambiguous，不提交 assistant', async (_name, bad) => {
      const { result, events, store, calls } = await runTurnWithSendResult(bad);

      expect(result.sendResult).toEqual({
        outcome: 'ambiguous_failure',
        sentIndexes: [],
        failedIndexes: [],
        retryable: false,
        retryAfterMs: null,
        reason: 'invalid_send_result',
      });
      expect(result.deliveredText).toBe('');
      expect(calls).toHaveLength(1);
      expect(records(store).filter((record) => record.role === 'assistant')).toEqual([]);
      expect(events.filter((event) => event.type === 'done')).toEqual([]);
      expect(events.filter((event) => event.type === 'failed')).toEqual([
        { type: 'failed', eventId: 'e1', reason: '发送结果非法' },
        { type: 'failed', eventId: 'e2', reason: '发送结果非法' },
      ]);
    });
  });

  it('零送达时 markFailed 持久化失败会被显式抛出', async () => {
    const store = new EventStore({ dir: join(dir, 'events'), now: () => NOW });
    seedUsers(store, ['e1']);
    const provider = providerReturning('一。');
    const registry = makeRegistry(store, () => provider);
    const { receipts } = makeReceipts({ markFailedThrows: true });
    const { sender } = senderReturning(() =>
      sendResultOf({ outcome: 'none_sent', failedIndexes: [0], reason: '失败' }),
    );

    await expect(
      runQqTurn({
        registry,
        sessionKey: SESSION,
        wake: wakeOf(['e1']),
        sender,
        receipts,
        target: TARGET,
        maxPerTurn: 3,
        signal: signal(),
      }),
    ).rejects.toThrow('receipt write failed');
    expect(records(store).filter((record) => record.role === 'assistant')).toEqual([]);
  });

  it('空回复计划：不发送，标记 failed，不写 assistant', async () => {
    const store = new EventStore({ dir: join(dir, 'events'), now: () => NOW });
    seedUsers(store, ['e1']);

    const requests: ChatRequest[] = [];
    const provider = providerReturning('   ', { calls: requests });
    const registry = makeRegistry(store, () => provider);
    const { receipts, events } = makeReceipts();
    const { sender, calls } = senderReturning(() => allSent(0));

    const result = await runQqTurn({
      registry,
      sessionKey: SESSION,
      wake: wakeOf(['e1']),
      sender,
      receipts,
      target: TARGET,
      maxPerTurn: 3,
      signal: signal(),
    });

    expect(result).toEqual({ plan: { messages: [] }, sendResult: null, deliveredText: '' });
    expect(requests).toHaveLength(1);
    expect(calls).toEqual([]);
    expect(records(store).filter((record) => record.role === 'assistant')).toEqual([]);
    expect(events.filter((event) => event.type === 'failed')).toEqual([
      { type: 'failed', eventId: 'e1', reason: '空回复，未发送' },
    ]);
  });

  it('markProcessing 失败：不调用 provider，全部标记 failed', async () => {
    const store = new EventStore({ dir: join(dir, 'events'), now: () => NOW });
    seedUsers(store, ['e1', 'e2']);

    const requests: ChatRequest[] = [];
    const provider = providerReturning('不应调用', { calls: requests });
    const registry = makeRegistry(store, () => provider);
    const { receipts, events } = makeReceipts({ processingFails: ['e2'] });
    const { sender, calls } = senderReturning(() => allSent(1));

    await expect(
      runQqTurn({
        registry,
        sessionKey: SESSION,
        wake: wakeOf(['e1', 'e2']),
        sender,
        receipts,
        target: TARGET,
        maxPerTurn: 3,
        signal: signal(),
      }),
    ).rejects.toThrow(/markProcessing/);

    expect(requests).toEqual([]);
    expect(calls).toEqual([]);
    expect(events.filter((event) => event.type === 'processing').map((event) => event.eventId)).toEqual([
      'e1',
      'e2',
    ]);
    expect(events.filter((event) => event.type === 'failed')).toEqual([
      { type: 'failed', eventId: 'e1', reason: 'processing 状态迁移失败' },
      { type: 'failed', eventId: 'e2', reason: 'processing 状态迁移失败' },
    ]);
  });

  it('provider 抛错：不发送、不写 assistant，全部标记 failed', async () => {
    const store = new EventStore({ dir: join(dir, 'events'), now: () => NOW });
    seedUsers(store, ['e1']);
    const provider: Provider = {
      id: 'deepseek',
      chat(): ChatEventStream {
        return (async function* (): AsyncGenerator<ChatEvent> {
          throw new Error('provider down');
        })();
      },
      usageOf: usageOfEvent,
      async health() {
        return { ok: true, detail: 'fake' };
      },
    };
    const registry = makeRegistry(store, () => provider);
    const { receipts, events } = makeReceipts();
    const { sender, calls } = senderReturning(() => allSent(1));

    await expect(
      runQqTurn({
        registry,
        sessionKey: SESSION,
        wake: wakeOf(['e1']),
        sender,
        receipts,
        target: TARGET,
        maxPerTurn: 3,
        signal: signal(),
      }),
    ).rejects.toThrow('provider down');

    expect(calls).toEqual([]);
    expect(records(store).filter((record) => record.role === 'assistant')).toEqual([]);
    expect(events.filter((event) => event.type === 'failed')).toEqual([
      { type: 'failed', eventId: 'e1', reason: '模型调用失败' },
    ]);
  });

  it('sender 抛错：不写 assistant，全部标记 failed', async () => {
    const store = new EventStore({ dir: join(dir, 'events'), now: () => NOW });
    seedUsers(store, ['e1']);
    const provider = providerReturning('一。');
    const registry = makeRegistry(store, () => provider);
    const { receipts, events } = makeReceipts();
    const sender: QqSender = {
      async send() {
        throw new Error('sender down');
      },
    };

    await expect(
      runQqTurn({
        registry,
        sessionKey: SESSION,
        wake: wakeOf(['e1']),
        sender,
        receipts,
        target: TARGET,
        maxPerTurn: 3,
        signal: signal(),
      }),
    ).rejects.toThrow('sender down');

    expect(records(store).filter((record) => record.role === 'assistant')).toEqual([]);
    expect(events.filter((event) => event.type === 'failed')).toEqual([
      { type: 'failed', eventId: 'e1', reason: '发送失败' },
    ]);
  });

  it('同 session 发送阻塞时，下一轮不启动', async () => {
    const store = new EventStore({ dir: join(dir, 'events'), now: () => NOW });
    seedUsers(store, ['e1', 'e2']);
    const timeline: string[] = [];
    let providerCalls = 0;

    const provider: Provider = {
      id: 'deepseek',
      chat(): ChatEventStream {
        providerCalls += 1;
        const call = providerCalls;
        timeline.push(`provider:${call}`);
        return (async function* (): AsyncGenerator<ChatEvent> {
          yield { type: 'text', text: `回复${call}。` };
          yield { type: 'done' };
        })();
      },
      usageOf: usageOfEvent,
      async health() {
        return { ok: true, detail: 'fake' };
      },
    };
    const registry = makeRegistry(store, () => provider);
    const { receipts } = makeReceipts({ timeline });

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let notifyStarted!: () => void;
    const sendStarted = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    let sendCalls = 0;
    const sender: QqSender = {
      async send(_target, messages) {
        sendCalls += 1;
        const call = sendCalls;
        timeline.push(`send:${call}:start`);
        if (call === 1) {
          notifyStarted();
          await gate;
        }
        timeline.push(`send:${call}:end`);
        return allSent(messages.length);
      },
    };

    const first = runQqTurn({
      registry,
      sessionKey: SESSION,
      wake: wakeOf(['e1'], '输入一'),
      sender,
      receipts,
      target: TARGET,
      maxPerTurn: 3,
      signal: signal(),
    });
    const second = runQqTurn({
      registry,
      sessionKey: SESSION,
      wake: wakeOf(['e2'], '输入二'),
      sender,
      receipts,
      target: TARGET,
      maxPerTurn: 3,
      signal: signal(),
    });

    await sendStarted;
    expect(providerCalls).toBe(1);
    expect(sendCalls).toBe(1);

    release();
    await Promise.all([first, second]);

    expect(providerCalls).toBe(2);
    expect(timeline).toEqual([
      'processing:e1',
      'provider:1',
      'send:1:start',
      'send:1:end',
      'done:e1',
      'processing:e2',
      'provider:2',
      'send:2:start',
      'send:2:end',
      'done:e2',
    ]);
  });

  it('不同 session 可并行（发送阻塞不串行化另一会话）', async () => {
    const store = new EventStore({ dir: join(dir, 'events'), now: () => NOW });
    seedUsers(store, ['e1'], 'private:1');
    seedUsers(store, ['e2'], 'private:2');
    const providerCounts = new Map<string, number>();
    const registry = makeRegistry(store, (sessionKey) => {
      providerCounts.set(sessionKey, 0);
      const base = providerReturning(`回复-${sessionKey}。`);
      return {
        ...base,
        chat(req, opts): ChatEventStream {
          providerCounts.set(sessionKey, (providerCounts.get(sessionKey) ?? 0) + 1);
          return base.chat(req, opts);
        },
      };
    });
    const { receipts } = makeReceipts();

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = 0;
    let notifyBoth!: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      notifyBoth = resolve;
    });
    const sender: QqSender = {
      async send(_target, messages) {
        started += 1;
        if (started === 2) notifyBoth();
        await gate;
        return allSent(messages.length);
      },
    };

    const first = runQqTurn({
      registry,
      sessionKey: 'private:1',
      wake: wakeOf(['e1'], '输入一', 'private:1'),
      sender,
      receipts,
      target: { kind: 'private', id: '1' },
      maxPerTurn: 3,
      signal: signal(),
    });
    const second = runQqTurn({
      registry,
      sessionKey: 'private:2',
      wake: wakeOf(['e2'], '输入二', 'private:2'),
      sender,
      receipts,
      target: { kind: 'private', id: '2' },
      maxPerTurn: 3,
      signal: signal(),
    });

    await Promise.race([
      bothStarted,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('跨 session 未并行')), 1000),
      ),
    ]);
    expect(providerCounts.get('private:1')).toBe(1);
    expect(providerCounts.get('private:2')).toBe(1);

    release();
    await Promise.all([first, second]);
    const assistantKeys = records(store)
      .filter((record) => record.role === 'assistant')
      .map((record) => record.sessionKey)
      .sort();
    expect(assistantKeys).toEqual(['private:1', 'private:2']);
  });

  it('owner 记忆命令先于模型执行：不调用 provider，命令回复照常发送并收尾', async () => {
    const store = new EventStore({ dir: join(dir, 'events'), now: () => NOW });
    seedUsers(store, ['e1']);
    let providerCalls = 0;
    const provider = providerReturning('不应被调用');
    const registry = makeRegistry(store, () => ({
      ...provider,
      chat(req, opts): ChatEventStream {
        providerCalls += 1;
        return provider.chat(req, opts);
      },
    }));
    const { receipts, events } = makeReceipts();
    const { sender, calls } = senderReturning(() => allSent(1));

    const result = await runQqTurn({
      registry,
      sessionKey: SESSION,
      wake: wakeOf(['e1'], '!记 他不吃香菜'),
      sender,
      receipts,
      target: TARGET,
      maxPerTurn: 3,
      signal: signal(),
      commands: async () => ({ handled: true, messages: ['已记住：他不吃香菜'] }),
    });

    expect(providerCalls).toBe(0);
    expect(calls[0]?.messages).toEqual(['已记住：他不吃香菜']);
    expect(result.deliveredText).toBe('已记住：他不吃香菜');
    expect(events).toEqual([
      { type: 'processing', eventId: 'e1' },
      { type: 'done', eventId: 'e1', sentIndexes: [0], failedIndexes: [] },
    ]);
    expect(records(store).filter((record) => record.role === 'assistant')).toHaveLength(0);
  });

  it('命令多条回复按换行合并后走完整回复策略，不受 maxPerTurn 截断', async () => {
    const store = new EventStore({ dir: join(dir, 'events'), now: () => NOW });
    seedUsers(store, ['e1']);
    let providerCalls = 0;
    const base = providerReturning('不应被调用');
    const registry = makeRegistry(store, () => ({
      ...base,
      chat(req, opts): ChatEventStream {
        providerCalls += 1;
        return base.chat(req, opts);
      },
    }));
    const { receipts } = makeReceipts();
    const { sender, calls } = senderReturning(() => allSent(1));
    const commandMessages = ['第一段。', '第二段！', '第三段？', '第四段'];

    const result = await runQqTurn({
      registry,
      sessionKey: SESSION,
      wake: wakeOf(['e1'], '!整理'),
      sender,
      receipts,
      target: TARGET,
      maxPerTurn: 1,
      signal: signal(),
      commands: async () => ({ handled: true, messages: commandMessages }),
    });

    const joined = commandMessages.join('\n');
    expect(providerCalls).toBe(0);
    expect(result.plan.messages).toEqual([joined]);
    expect(result.deliveredText).toBe(joined);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.messages).toEqual([joined]);
    expect(records(store).filter((record) => record.role === 'assistant')).toHaveLength(0);
  });

  it('recovered owner 不执行记忆命令，按普通模型回合处理', async () => {
    const store = new EventStore({ dir: join(dir, 'events'), now: () => NOW });
    seedUsers(store, ['e1']);
    let providerCalls = 0;
    let commandCalls = 0;
    const base = providerReturning('模型回复。');
    const registry = makeRegistry(store, () => ({
      ...base,
      chat(req, opts): ChatEventStream {
        providerCalls += 1;
        return base.chat(req, opts);
      },
    }));
    const { receipts } = makeReceipts();
    const { sender, calls } = senderReturning(() => allSent(1));

    const result = await runQqTurn({
      registry,
      sessionKey: SESSION,
      wake: wakeOf(['e1'], '!称呼 大肥鱼', SESSION, 'owner', 'recovered'),
      sender,
      receipts,
      target: TARGET,
      maxPerTurn: 3,
      signal: signal(),
      commands: async () => {
        commandCalls += 1;
        return { handled: true, messages: ['不应发送'] };
      },
    });

    expect(commandCalls).toBe(0);
    expect(providerCalls).toBe(1);
    expect(result.plan.messages).toEqual(['模型回复。']);
    expect(calls[0]?.messages).toEqual(['模型回复。']);
  });

  it('普通成员回合保留完整文本但只发一条，且经过成员限流闸门', async () => {
    const store = new EventStore({ dir: join(dir, 'events'), now: () => NOW });
    seedUsers(store, ['e1'], 'group:9');
    const reply = Array.from({ length: 10 }, (_, index) => `成员第${index + 1}句。`).join('');
    const provider = providerReturning(reply);
    const registry = makeRegistry(store, () => provider);
    const { receipts, events } = makeReceipts();
    const { sender, calls } = senderReturning(() => allSent(1));
    let gateCalls = 0;

    const result = await runQqTurn({
      registry,
      sessionKey: 'group:9',
      wake: wakeOf(['e1'], '成员输入', 'group:9', 'member'),
      sender,
      receipts,
      target: { kind: 'group', id: '9' },
      maxPerTurn: 3,
      signal: signal(),
      memberReplyGate: {
        async acquire() {
          gateCalls += 1;
          return true;
        },
      },
    });

    expect(gateCalls).toBe(1);
    expect(result.plan.messages).toEqual([reply]);
    expect(calls[0]?.messages).toEqual([reply]);
    expect(events).toEqual([
      { type: 'processing', eventId: 'e1' },
      { type: 'done', eventId: 'e1', sentIndexes: [0], failedIndexes: [] },
    ]);
  });

  it('普通成员不执行 owner 命令，仍走模型', async () => {
    const store = new EventStore({ dir: join(dir, 'events'), now: () => NOW });
    seedUsers(store, ['e1'], 'group:9');
    let providerCalls = 0;
    let commandCalls = 0;
    const base = providerReturning('普通回复。');
    const registry = makeRegistry(store, () => ({
      ...base,
      chat(req, opts): ChatEventStream {
        providerCalls += 1;
        return base.chat(req, opts);
      },
    }));
    const { receipts } = makeReceipts();
    const { sender } = senderReturning(() => allSent(1));

    await runQqTurn({
      registry,
      sessionKey: 'group:9',
      wake: wakeOf(['e1'], '!记 不应执行', 'group:9', 'member'),
      sender,
      receipts,
      target: { kind: 'group', id: '9' },
      maxPerTurn: 3,
      signal: signal(),
      commands: async () => {
        commandCalls += 1;
        return { handled: true, messages: ['不应发送'] };
      },
    });

    expect(commandCalls).toBe(0);
    expect(providerCalls).toBe(1);
  });

  it('普通成员被限流：不发送、不写 assistant，Receipt 标 failed', async () => {
    const store = new EventStore({ dir: join(dir, 'events'), now: () => NOW });
    seedUsers(store, ['e1'], 'group:9');
    const provider = providerReturning('不应发送。');
    const registry = makeRegistry(store, () => provider);
    const { receipts, events } = makeReceipts();
    const { sender, calls } = senderReturning(() => allSent(1));

    const result = await runQqTurn({
      registry,
      sessionKey: 'group:9',
      wake: wakeOf(['e1'], '成员输入', 'group:9', 'member'),
      sender,
      receipts,
      target: { kind: 'group', id: '9' },
      maxPerTurn: 3,
      signal: signal(),
      memberReplyGate: {
        async acquire() {
          return false;
        },
      },
    });

    expect(calls).toEqual([]);
    expect(result.sendResult?.reason).toBe('rate_limited');
    expect(events).toEqual([
      { type: 'processing', eventId: 'e1' },
      { type: 'failed', eventId: 'e1', reason: '成员回复限流' },
    ]);
    expect(records(store).filter((record) => record.role === 'assistant')).toHaveLength(0);
  });

  it('owner 回合不经过成员限流', async () => {
    const store = new EventStore({ dir: join(dir, 'events'), now: () => NOW });
    seedUsers(store, ['e1']);
    const provider = providerReturning('owner 回复。');
    const registry = makeRegistry(store, () => provider);
    const { receipts } = makeReceipts();
    const { sender, calls } = senderReturning(() => allSent(1));
    let gateCalls = 0;

    await runQqTurn({
      registry,
      sessionKey: SESSION,
      wake: wakeOf(['e1'], 'owner 输入'),
      sender,
      receipts,
      target: TARGET,
      maxPerTurn: 3,
      signal: signal(),
      memberReplyGate: {
        async acquire() {
          gateCalls += 1;
          return false;
        },
      },
    });

    expect(gateCalls).toBe(0);
    expect(calls).toHaveLength(1);
  });
});
