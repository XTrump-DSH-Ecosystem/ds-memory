import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Agent } from '../../src/agent/loop.ts';
import {
  TOOL_LOOP_BUDGET_ERROR_CONTENT,
  TOOL_LOOP_MAX_MODEL_CALLS,
  TOOL_LOOP_TOOL_LIMIT_ERROR_CONTENT,
} from '../../src/agent/tool-loop.ts';
import { FactsStore } from '../../src/memory/facts.ts';
import { SelfNoteStore } from '../../src/memory/selfnote.ts';
import type { Retriever } from '../../src/memory/retriever/types.ts';
import { EventStore, monthOf } from '../../src/memory/store.ts';
import {
  ProviderAbortError,
  usageOfEvent,
  type ChatEvent,
  type ChatEventStream,
  type ChatRequest,
  type Provider,
  type ProviderMessage,
  type TokenUsage,
  type ToolCall,
} from '../../src/provider/types.ts';
import { readSessionState } from '../../src/state/persist.ts';
import { WEB_TOOL_TRUNCATION_MARKER } from '../../src/tools/web/budget.ts';
import type {
  AgentWebToolRuntime,
  WebToolExecutionResult,
  WebToolSpec,
} from '../../src/tools/web/index.ts';

const SESSION_KEY = 'cli:owner';
const NOW = 1_700_000_000_000;
const MONTH = monthOf(NOW);

let dir: string;
let agentCounter = 0;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 't1-w3-acceptance-'));
  agentCounter = 0;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

interface ScriptStep {
  events: ChatEvent[];
  errorAfter?: unknown;
}

class ScriptedProvider implements Provider {
  readonly id = 'deepseek' as const;
  readonly supportsTools: boolean | undefined;
  readonly requests: ChatRequest[] = [];
  readonly signals: AbortSignal[] = [];
  private readonly steps: ScriptStep[];
  private index = 0;

  constructor(
    steps: ScriptStep[],
    supportsTools: boolean | 'omit' = true,
  ) {
    this.steps = steps;
    this.supportsTools = supportsTools === 'omit' ? undefined : supportsTools;
  }

  chat(req: ChatRequest, opts: { signal: AbortSignal }): ChatEventStream {
    const step = this.steps[this.index];
    this.index += 1;
    if (!step) throw new Error(`unexpected provider call ${this.index}`);
    this.requests.push(cloneRequest(req));
    this.signals.push(opts.signal);

    return (async function* (): AsyncGenerator<ChatEvent> {
      for (const event of step.events) yield event;
      if (step.errorAfter !== undefined) throw step.errorAfter;
    })();
  }

  usageOf(event: ChatEvent): TokenUsage | null {
    return usageOfEvent(event);
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    return { ok: true, detail: 'fake' };
  }
}

type ExecuteBehavior = (
  call: ToolCall,
  callNumber: number,
  options: { signal?: AbortSignal },
) =>
  | WebToolExecutionResult
  | Promise<WebToolExecutionResult | undefined>
  | undefined;

class FakeRuntime implements AgentWebToolRuntime {
  readonly specs: readonly WebToolSpec[] = [
    {
      name: 'web_search',
      description: 'fake search',
      parameters: { type: 'object', properties: {} },
    },
    {
      name: 'web_fetch',
      description: 'fake fetch',
      parameters: { type: 'object', properties: {} },
    },
  ];
  readonly executed: ToolCall[] = [];
  readonly signals: Array<AbortSignal | undefined> = [];
  readonly ownerSessionKey: string;
  readonly maxResultChars: number;
  readonly maxRoundChars: number;
  beginTurnCalls = 0;
  private readonly behavior: ExecuteBehavior | undefined;

  constructor(
    ownerSessionKey = SESSION_KEY,
    behavior?: ExecuteBehavior,
    maxResultChars = 12_000,
    maxRoundChars = 24_000,
  ) {
    this.ownerSessionKey = ownerSessionKey;
    this.behavior = behavior;
    this.maxResultChars = maxResultChars;
    this.maxRoundChars = maxRoundChars;
  }

  beginTurn(): void {
    this.beginTurnCalls += 1;
  }

  async execute(
    call: ToolCall,
    options: { signal?: AbortSignal } = {},
  ): Promise<WebToolExecutionResult> {
    this.executed.push(call);
    this.signals.push(options.signal);
    const custom = await this.behavior?.(call, this.executed.length, options);
    return (
      custom ?? {
        toolCallId: call.id,
        name: call.name,
        ok: true,
        content: `result:${call.id}`,
        truncated: false,
      }
    );
  }
}

function cloneRequest(req: ChatRequest): ChatRequest {
  return {
    sessionId: req.sessionId,
    messages: req.messages.map(cloneMessage),
    ...(req.tools
      ? {
          tools: req.tools.map((tool) => ({
            ...tool,
            ...(tool.parameters ? { parameters: JSON.parse(JSON.stringify(tool.parameters)) } : {}),
          })),
        }
      : {}),
  };
}

function cloneMessage(message: ProviderMessage): ProviderMessage {
  if (message.role === 'tool') return { ...message };
  if (message.role === 'assistant' && 'toolCalls' in message) {
    return {
      role: 'assistant',
      content: message.content,
      toolCalls: message.toolCalls.map((call) => ({ ...call })),
      reasoningContent: message.reasoningContent,
    };
  }
  return { ...message };
}

function toolCall(id: string): ToolCall {
  return {
    id,
    name: 'web_search',
    argumentsText: JSON.stringify({ query: `query-${id}` }),
  };
}

function toolCallsEvent(calls: ToolCall[], reasoningContent = ''): ChatEvent {
  return { type: 'tool_calls', toolCalls: calls, reasoningContent };
}

function usageEvent(
  promptTokens: number,
  completionTokens: number,
  totalTokens: number,
): ChatEvent {
  return {
    type: 'usage',
    usage: { promptTokens, completionTokens, totalTokens },
  };
}

function textEvent(text: string): ChatEvent {
  return { type: 'text', text };
}

const DONE: ChatEvent = { type: 'done' };

interface Harness {
  agent: Agent;
  store: EventStore;
  sessionsDir: string;
  factsDir: string;
  notesDir: string;
  logs: string[];
}

function makeAgent(
  provider: Provider,
  options: { memory?: boolean } = {},
): Harness {
  const root = join(dir, `agent-${agentCounter}`);
  agentCounter += 1;
  const store = new EventStore({ dir: join(root, 'events'), now: () => NOW });
  const sessionsDir = join(root, 'sessions');
  const factsDir = join(root, 'facts');
  const notesDir = join(root, 'selfnotes');
  const logs: string[] = [];

  let memory: ConstructorParameters<typeof Agent>[0]['memory'];
  if (options.memory) {
    const facts = new FactsStore({
      dir: factsDir,
      halfLifeDays: 30,
      archiveThreshold: 0.1,
      injectMax: 10,
      injectMaxChars: 2_000,
      now: () => NOW,
      onWarn: (message) => logs.push(message),
    });
    const selfNotes = new SelfNoteStore({
      dir: notesDir,
      max: 10,
      bootstrapLimit: 10,
      now: () => NOW,
      onWarn: (message) => logs.push(message),
    });
    const retriever: Retriever = {
      id: 'bigram',
      async search() {
        return [];
      },
      stats() {
        return { docs: 0 };
      },
    };
    facts.upsert(SESSION_KEY, 'FACT_KEEP_SENTINEL', 'misc');
    selfNotes.upsert(SESSION_KEY, 'NOTE_KEEP_SENTINEL');
    memory = {
      facts,
      selfNotes,
      retriever,
      recall: { trigger: 'off', budgetChars: 1_000, budgetItems: 5 },
    };
  }

  const agent = new Agent({
    provider,
    store,
    persona: 'T1 acceptance',
    sessionKey: SESSION_KEY,
    now: () => NOW,
    ...(memory ? { memory } : {}),
    ...(options.memory
      ? {
          summary: 'SUMMARY_KEEP_SENTINEL',
          compaction: {
            enabled: true,
            idleMs: 100_000,
            thresholdTokens: 1_000_000,
            minTurns: 6,
            sessionStateDir: sessionsDir,
          },
        }
      : {}),
    onWarn: (message) => logs.push(message),
    onInfo: (message) => logs.push(message),
  });

  return { agent, store, sessionsDir, factsDir, notesDir, logs };
}

function totalToolChars(messages: ProviderMessage[]): number {
  return messages
    .filter((message): message is Extract<ProviderMessage, { role: 'tool' }> => message.role === 'tool')
    .reduce((sum, message) => sum + Array.from(message.content).length, 0);
}

function toolMessages(messages: ProviderMessage[]): Array<Extract<ProviderMessage, { role: 'tool' }>> {
  return messages.filter(
    (message): message is Extract<ProviderMessage, { role: 'tool' }> => message.role === 'tool',
  );
}

describe('T1 W3 独立验收：有界工具循环', () => {
  it.each<[string, boolean | 'omit']>([
    ['false', false],
    ['undefined', 'omit'],
  ])(
    'provider.supportsTools=%s 时 Agent 在 provider/beginTurn/L0 前拒绝',
    async (_label, supportsTools) => {
      const provider = new ScriptedProvider(
        [{ events: [textEvent('不应调用'), DONE] }],
        supportsTools,
      );
      const runtime = new FakeRuntime();
      const { agent, store, sessionsDir } = makeAgent(provider);

      await expect(
        agent.runTurn('不应开始', {
          signal: new AbortController().signal,
          webTools: runtime,
        }),
      ).rejects.toThrow(/不支持工具调用/);

      expect(provider.requests).toHaveLength(0);
      expect(runtime.beginTurnCalls).toBe(0);
      expect(runtime.executed).toHaveLength(0);
      expect(store.readMonth(MONTH)).toEqual([]);
      expect(agent.historyMessageCount).toBe(0);
      expect(readSessionState(sessionsDir, SESSION_KEY)).toBeNull();
    },
  );

  it('ownerSessionKey 不匹配时 provider/beginTurn/L0/history/state 全部不变', async () => {
    const provider = new ScriptedProvider([{ events: [textEvent('不应调用'), DONE] }]);
    const runtime = new FakeRuntime('qq:private:other');
    const { agent, store, sessionsDir } = makeAgent(provider);

    await expect(
      agent.runTurn('不应开始', {
        signal: new AbortController().signal,
        webTools: runtime,
      }),
    ).rejects.toThrow(/ownerSessionKey.*不匹配/);

    expect(provider.requests).toHaveLength(0);
    expect(runtime.beginTurnCalls).toBe(0);
    expect(store.readMonth(MONTH)).toEqual([]);
    expect(agent.historyMessageCount).toBe(0);
    expect(readSessionState(sessionsDir, SESSION_KEY)).toBeNull();
  });

  it('最多 4 次模型调用；第 4 次无 tools；第 5 个 tool call 起只回填结构化错误', async () => {
    const provider = new ScriptedProvider([
      { events: [toolCallsEvent([toolCall('c1'), toolCall('c2')]), DONE] },
      {
        events: [
          toolCallsEvent([toolCall('c3'), toolCall('c4'), toolCall('c5')]),
          DONE,
        ],
      },
      { events: [toolCallsEvent([toolCall('c6')]), DONE] },
      { events: [textEvent('FINAL'), DONE] },
    ]);
    const runtime = new FakeRuntime();
    const { agent } = makeAgent(provider);

    const result = await agent.runTurn('多轮工具', {
      signal: new AbortController().signal,
      webTools: runtime,
    });

    expect(provider.requests).toHaveLength(TOOL_LOOP_MAX_MODEL_CALLS);
    expect(provider.requests[3]!.tools).toBeUndefined();
    expect(runtime.executed.map((call) => call.id)).toEqual(['c1', 'c2', 'c3', 'c4']);
    expect(result.text).toBe('FINAL');

    const finalTools = toolMessages(provider.requests[3]!.messages);
    expect(finalTools).toHaveLength(6);
    expect(finalTools[4]!.content).toBe(TOOL_LOOP_TOOL_LIMIT_ERROR_CONTENT);
    expect(finalTools[5]!.content).toBe(TOOL_LOOP_TOOL_LIMIT_ERROR_CONTENT);
    expect(totalToolChars(provider.requests[3]!.messages)).toBeLessThanOrEqual(
      runtime.maxRoundChars,
    );
  });

  it('第 4 次模型调用即使返回 tool_calls 也不执行，且返回确定性空串', async () => {
    const provider = new ScriptedProvider([
      { events: [toolCallsEvent([toolCall('c1')]), DONE] },
      { events: [toolCallsEvent([toolCall('c2')]), DONE] },
      { events: [toolCallsEvent([toolCall('c3')]), DONE] },
      { events: [toolCallsEvent([toolCall('c4-must-not-run')]), DONE] },
    ]);
    const runtime = new FakeRuntime();
    const { agent, store } = makeAgent(provider);

    const result = await agent.runTurn('一直要工具', {
      signal: new AbortController().signal,
      webTools: runtime,
    });

    expect(provider.requests).toHaveLength(TOOL_LOOP_MAX_MODEL_CALLS);
    expect(provider.requests[3]!.tools).toBeUndefined();
    expect(runtime.executed.map((call) => call.id)).toEqual(['c1', 'c2', 'c3']);
    expect(result.text).toBe('');
    expect(result.interrupted).toBe(false);
    expect(store.readMonth(MONTH).map((record) => record.role)).toEqual(['user']);
  });

  it('20k 字符单结果被硬截断到 maxResultChars 且带截断标记，总和 ≤ 24000', async () => {
    const provider = new ScriptedProvider([
      { events: [toolCallsEvent([toolCall('large')]), DONE] },
      { events: [textEvent('AFTER_TRUNCATION'), DONE] },
    ]);
    const runtime = new FakeRuntime(SESSION_KEY, () => ({
      toolCallId: 'large',
      name: 'web_search',
      ok: true,
      content: '😀'.repeat(20_000),
      truncated: false,
    }));
    const { agent } = makeAgent(provider);

    const result = await agent.runTurn('单条超限', {
      signal: new AbortController().signal,
      webTools: runtime,
    });

    const finalTools = toolMessages(provider.requests[1]!.messages);
    expect(finalTools).toHaveLength(1);
    expect(Array.from(finalTools[0]!.content).length).toBeLessThanOrEqual(
      runtime.maxResultChars,
    );
    expect(finalTools[0]!.content.endsWith(WEB_TOOL_TRUNCATION_MARKER)).toBe(true);
    expect(totalToolChars(provider.requests[1]!.messages)).toBeLessThanOrEqual(
      runtime.maxRoundChars,
    );
    expect(result.text).toBe('AFTER_TRUNCATION');
  });

  it('成功结果 + tool_call_limit 错误文本共用 24000 预算', async () => {
    const provider = new ScriptedProvider([
      {
        events: [
          toolCallsEvent([
            toolCall('a'),
            toolCall('b'),
            toolCall('c'),
            toolCall('d'),
            toolCall('e'),
          ]),
          DONE,
        ],
      },
      { events: [toolCallsEvent([toolCall('f')]), DONE] },
      { events: [textEvent('DONE'), DONE] },
    ]);
    const runtime = new FakeRuntime(SESSION_KEY, () => ({
      toolCallId: 'x',
      name: 'web_search',
      ok: true,
      content: 'x'.repeat(5_500),
      truncated: false,
    }));
    const { agent } = makeAgent(provider);

    await agent.runTurn('限制与预算', {
      signal: new AbortController().signal,
      webTools: runtime,
    });

    const finalTools = toolMessages(provider.requests[2]!.messages);
    expect(finalTools).toHaveLength(6);
    expect(finalTools.filter((message) => message.content === TOOL_LOOP_TOOL_LIMIT_ERROR_CONTENT)).toHaveLength(2);
    const total = totalToolChars(provider.requests[2]!.messages);
    expect(total).toBeLessThanOrEqual(24_000);
    expect(total).toBeGreaterThan(22_000);
  });

  it('预算超限后不再执行后续工具，所有后续 tool 消息复用固定错误且总和 ≤ 24000', async () => {
    const provider = new ScriptedProvider([
      {
        events: [
          toolCallsEvent([toolCall('a'), toolCall('b'), toolCall('c'), toolCall('d')]),
          DONE,
        ],
      },
      { events: [toolCallsEvent([toolCall('e'), toolCall('f')]), DONE] },
      { events: [textEvent('BUDGET_DONE'), DONE] },
    ]);
    const runtime = new FakeRuntime(SESSION_KEY, () => ({
      toolCallId: 'x',
      name: 'web_search',
      ok: true,
      content: 'y'.repeat(9_000),
      truncated: false,
    }));
    const { agent } = makeAgent(provider);

    const result = await agent.runTurn('预算超限', {
      signal: new AbortController().signal,
      webTools: runtime,
    });

    expect(runtime.executed.map((call) => call.id)).toEqual(['a', 'b', 'c']);
    const finalTools = toolMessages(provider.requests[2]!.messages);
    expect(finalTools).toHaveLength(6);
    expect(finalTools.slice(2).every((message) => message.content === TOOL_LOOP_BUDGET_ERROR_CONTENT)).toBe(true);
    expect(totalToolChars(provider.requests[2]!.messages)).toBeLessThanOrEqual(24_000);
    expect(result.text).toBe('BUDGET_DONE');
  });

  it('工具中间消息不进入 L0/history/facts/selfNote/summary/compaction/state', async () => {
    const provider = new ScriptedProvider([
      {
        events: [
          textEvent('INTERMEDIATE_TEXT_SENTINEL'),
          toolCallsEvent([toolCall('temp')], 'REASONING_SENTINEL'),
          DONE,
        ],
      },
      { events: [textEvent('FINAL_OK'), DONE] },
    ]);
    const runtime = new FakeRuntime(SESSION_KEY, () => ({
      toolCallId: 'temp',
      name: 'web_search',
      ok: true,
      content: 'TOOL_BODY_SENTINEL',
      truncated: false,
    }));
    const { agent, store, sessionsDir, factsDir, notesDir, logs } = makeAgent(provider, {
      memory: true,
    });
    const chunks: string[] = [];

    const result = await agent.runTurn('发送前检查', {
      signal: new AbortController().signal,
      webTools: runtime,
      writeAssistantL0: false,
      onText: (chunk) => chunks.push(chunk),
    });

    expect(result.text).toBe('FINAL_OK');
    expect(chunks.join('')).toBe('FINAL_OK');
    expect(chunks.join('')).not.toContain('INTERMEDIATE_TEXT_SENTINEL');
    expect(provider.requests).toHaveLength(2);
    expect(store.readMonth(MONTH).map((record) => record.role)).toEqual(['user']);
    expect(agent.historyMessageCount).toBe(1);

    const stateBeforeCommit = readSessionState(sessionsDir, SESSION_KEY);
    expect(stateBeforeCommit?.summary).toBe('SUMMARY_KEEP_SENTINEL');
    expect(stateBeforeCommit?.history?.map((message) => message.role)).toEqual(['user']);

    const persistedBefore = JSON.stringify(stateBeforeCommit);
    for (const sentinel of [
      'TOOL_BODY_SENTINEL',
      'INTERMEDIATE_TEXT_SENTINEL',
      'REASONING_SENTINEL',
    ]) {
      expect(persistedBefore).not.toContain(sentinel);
      expect(JSON.stringify(store.readMonth(MONTH))).not.toContain(sentinel);
      expect(logs.join('\n')).not.toContain(sentinel);
    }

    const factsPath = join(factsDir, 'cli_owner.jsonl');
    const notesPath = join(notesDir, 'cli_owner.jsonl');
    expect(existsSync(factsPath)).toBe(true);
    expect(existsSync(notesPath)).toBe(true);
    expect(readFileSync(factsPath, 'utf8')).toContain('FACT_KEEP_SENTINEL');
    expect(readFileSync(notesPath, 'utf8')).toContain('NOTE_KEEP_SENTINEL');
    expect(readFileSync(factsPath, 'utf8')).not.toContain('TOOL_BODY_SENTINEL');
    expect(readFileSync(factsPath, 'utf8')).not.toContain('REASONING_SENTINEL');
    expect(readFileSync(notesPath, 'utf8')).not.toContain('TOOL_BODY_SENTINEL');
    expect(readFileSync(notesPath, 'utf8')).not.toContain('INTERMEDIATE_TEXT_SENTINEL');

    agent.commitAssistant('FINAL_OK');

    expect(store.readMonth(MONTH).map((record) => record.role)).toEqual([
      'user',
      'assistant',
    ]);
    const stateAfterCommit = readSessionState(sessionsDir, SESSION_KEY);
    expect(stateAfterCommit?.history?.map((message) => message.role)).toEqual([
      'user',
      'assistant',
    ]);
    expect(JSON.stringify(stateAfterCommit)).not.toContain('TOOL_BODY_SENTINEL');
    expect(JSON.stringify(stateAfterCommit)).not.toContain('REASONING_SENTINEL');
  });

  it('assistant 回填 toolCalls 时 reasoningContent 可为空串且键存在', async () => {
    const provider = new ScriptedProvider([
      { events: [toolCallsEvent([toolCall('empty-reasoning')], ''), DONE] },
      { events: [textEvent('FINAL'), DONE] },
    ]);
    const runtime = new FakeRuntime();
    const { agent } = makeAgent(provider);

    await agent.runTurn('空推理', {
      signal: new AbortController().signal,
      webTools: runtime,
    });

    const assistant = provider.requests[1]!.messages.find(
      (message) => message.role === 'assistant' && 'toolCalls' in message,
    );
    expect(assistant).toBeDefined();
    expect(assistant && 'reasoningContent' in assistant).toBe(true);
    if (assistant && 'reasoningContent' in assistant) {
      expect(assistant.reasoningContent).toBe('');
    }
  });

  it('reasoningContent 原样进入同轮 assistant 请求，不出现在 onText/日志/持久化', async () => {
    const sentinel = 'REASONING_LEAK_SENTINEL_42';
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const provider = new ScriptedProvider([
      { events: [toolCallsEvent([toolCall('r1')], sentinel), DONE] },
      { events: [textEvent('FINAL'), DONE] },
    ]);
    const runtime = new FakeRuntime();
    const { agent, store, sessionsDir, logs } = makeAgent(provider);
    const chunks: string[] = [];

    await agent.runTurn('推理不外泄', {
      signal: new AbortController().signal,
      webTools: runtime,
      onText: (chunk) => chunks.push(chunk),
    });

    const assistant = provider.requests[1]!.messages.find(
      (message) => message.role === 'assistant' && 'toolCalls' in message,
    );
    expect(assistant).toMatchObject({ reasoningContent: sentinel });
    expect(chunks.join('')).not.toContain(sentinel);
    expect(logs.join('\n')).not.toContain(sentinel);
    expect(JSON.stringify(store.readMonth(MONTH))).not.toContain(sentinel);
    expect(JSON.stringify(readSessionState(sessionsDir, SESSION_KEY))).not.toContain(sentinel);
    for (const spy of [consoleLog, consoleWarn, consoleError]) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it('onText 只回放最终轮；纯文本路径仍逐块实时回放', async () => {
    const provider = new ScriptedProvider([
      { events: [textEvent('DRAFT_1'), toolCallsEvent([toolCall('t1')]), DONE] },
      { events: [textEvent('DRAFT_2'), toolCallsEvent([toolCall('t2')]), DONE] },
      { events: [textEvent('FINAL_'), textEvent('TEXT'), DONE] },
    ]);
    const runtime = new FakeRuntime();
    const { agent } = makeAgent(provider);
    const chunks: string[] = [];

    const result = await agent.runTurn('工具流式', {
      signal: new AbortController().signal,
      webTools: runtime,
      onText: (chunk) => chunks.push(chunk),
    });

    expect(result.text).toBe('FINAL_TEXT');
    expect(chunks.join('')).toBe('FINAL_TEXT');
    expect(chunks.join('')).not.toContain('DRAFT');

    let releaseSecond!: () => void;
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    let firstSeenResolve!: () => void;
    const firstSeen = new Promise<void>((resolve) => {
      firstSeenResolve = resolve;
    });
    const streamProvider: Provider = {
      id: 'deepseek',
      supportsTools: true,
      chat(): ChatEventStream {
        return (async function* (): AsyncGenerator<ChatEvent> {
          yield textEvent('A');
          firstSeenResolve();
          await secondGate;
          yield textEvent('B');
          yield DONE;
        })();
      },
      usageOf: usageOfEvent,
      async health() {
        return { ok: true, detail: 'fake' };
      },
    };
    const { agent: streamAgent } = makeAgent(streamProvider);
    const streamed: string[] = [];
    let settled = false;
    const runPromise = streamAgent
      .runTurn('纯文本流式', {
        signal: new AbortController().signal,
        onText: (chunk) => streamed.push(chunk),
      })
      .then((value) => {
        settled = true;
        return value;
      });

    await firstSeen;
    expect(streamed).toEqual(['A']);
    expect(settled).toBe(false);
    releaseSecond();
    const streamedResult = await runPromise;
    expect(streamedResult.text).toBe('AB');
    expect(streamed).toEqual(['A', 'B']);
  });

  it('usage 跨轮求和并累计到 Agent；无最终文本时确定性空串', async () => {
    const provider = new ScriptedProvider([
      { events: [toolCallsEvent([toolCall('u1')]), usageEvent(10, 5, 15), DONE] },
      { events: [textEvent('FINAL'), usageEvent(20, 7, 27), DONE] },
    ]);
    const runtime = new FakeRuntime();
    const { agent } = makeAgent(provider);

    const result = await agent.runTurn('用量', {
      signal: new AbortController().signal,
      webTools: runtime,
    });

    const expected: TokenUsage = {
      promptTokens: 30,
      completionTokens: 12,
      totalTokens: 42,
    };
    expect(result.usage).toEqual(expected);
    expect(agent.usageTotals).toEqual(expected);

    const emptyProvider = new ScriptedProvider([
      { events: [toolCallsEvent([toolCall('u2')]), DONE] },
      { events: [DONE] },
    ]);
    const { agent: emptyAgent, store: emptyStore } = makeAgent(emptyProvider);
    const chunks: string[] = [];
    const emptyResult = await emptyAgent.runTurn('没有正文', {
      signal: new AbortController().signal,
      webTools: new FakeRuntime(),
      onText: (chunk) => chunks.push(chunk),
    });
    expect(emptyResult.text).toBe('');
    expect(emptyResult.interrupted).toBe(false);
    expect(chunks).toEqual([]);
    expect(emptyStore.readMonth(MONTH).map((record) => record.role)).toEqual(['user']);
    expect(emptyAgent.historyMessageCount).toBe(1);
    expect(() => emptyAgent.commitAssistant('不应提交')).toThrow(/没有待提交/);
  });

  it('abort 传播：工具取消时抛 ProviderAbortError，且不写 assistant/history/state', async () => {
    const controller = new AbortController();
    const provider = new ScriptedProvider([
      { events: [toolCallsEvent([toolCall('abort')]), DONE] },
    ]);
    const runtime = new FakeRuntime(SESSION_KEY, (call) => {
      controller.abort();
      return {
        toolCallId: call.id,
        name: call.name,
        ok: false,
        content: '[web_tool_error:web_aborted] 联网请求已取消。',
        error: 'web_aborted',
        truncated: false,
      };
    });
    const { agent, store, sessionsDir } = makeAgent(provider);
    const chunks: string[] = [];

    await expect(
      agent.runTurn('中止', {
        signal: controller.signal,
        webTools: runtime,
        onText: (chunk) => chunks.push(chunk),
      }),
    ).rejects.toBeInstanceOf(ProviderAbortError);

    expect(runtime.beginTurnCalls).toBe(1);
    expect(runtime.signals[0]?.aborted).toBe(true);
    expect(provider.signals[0]?.aborted).toBe(true);
    expect(store.readMonth(MONTH).map((record) => record.role)).toEqual(['user']);
    expect(agent.historyMessageCount).toBe(0);
    expect(readSessionState(sessionsDir, SESSION_KEY)).toBeNull();
    expect(chunks).toEqual([]);
    expect(() => agent.commitAssistant('不应提交')).toThrow(/没有待提交/);
  });

  it('abort 传播：Provider 在工具轮抛 ProviderAbortError 时同样不落 assistant', async () => {
    const provider = new ScriptedProvider([
      {
        events: [toolCallsEvent([toolCall('p1')]), DONE],
        errorAfter: new ProviderAbortError(),
      },
    ]);
    const { agent, store, sessionsDir } = makeAgent(provider);

    await expect(
      agent.runTurn('Provider 中止', {
        signal: new AbortController().signal,
        webTools: new FakeRuntime(),
      }),
    ).rejects.toBeInstanceOf(ProviderAbortError);

    expect(store.readMonth(MONTH).map((record) => record.role)).toEqual(['user']);
    expect(agent.historyMessageCount).toBe(0);
    expect(readSessionState(sessionsDir, SESSION_KEY)).toBeNull();
  });

  it('整轮 deadline 可注入：Provider 挂起时超时以 ProviderAbortError 传播', async () => {
    const provider: Provider = {
      id: 'deepseek',
      supportsTools: true,
      chat(_req, { signal }): ChatEventStream {
        return (async function* (): AsyncGenerator<ChatEvent> {
          await new Promise<never>((_resolve, reject) => {
            const onAbort = () => reject(new DOMException('aborted', 'AbortError'));
            if (signal.aborted) onAbort();
            else signal.addEventListener('abort', onAbort, { once: true });
          });
          yield DONE;
        })();
      },
      usageOf: usageOfEvent,
      async health() {
        return { ok: true, detail: 'fake' };
      },
    };
    const runtime = new FakeRuntime();
    const { agent, store, sessionsDir } = makeAgent(provider);
    const startedAt = Date.now();

    await expect(
      agent.runTurn('整轮超时', {
        signal: new AbortController().signal,
        webTools: runtime,
        roundTimeoutMs: 50,
      }),
    ).rejects.toBeInstanceOf(ProviderAbortError);

    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(runtime.beginTurnCalls).toBe(1);
    expect(runtime.executed).toHaveLength(0);
    expect(store.readMonth(MONTH).map((record) => record.role)).toEqual(['user']);
    expect(agent.historyMessageCount).toBe(0);
    expect(readSessionState(sessionsDir, SESSION_KEY)).toBeNull();
  });

  it('整轮 deadline 可注入：工具挂起时同样超时收尾且 runtime signal 被 abort', async () => {
    const provider = new ScriptedProvider([
      { events: [toolCallsEvent([toolCall('hang')]), DONE] },
    ]);
    const runtime = new FakeRuntime(SESSION_KEY, async (_call, _number, options) => {
      await new Promise<never>((_resolve, reject) => {
        const signal = options.signal;
        const onAbort = () => reject(new DOMException('aborted', 'AbortError'));
        if (signal?.aborted) onAbort();
        else signal?.addEventListener('abort', onAbort, { once: true });
      });
      return undefined;
    });
    const { agent, store, sessionsDir } = makeAgent(provider);

    await expect(
      agent.runTurn('工具超时', {
        signal: new AbortController().signal,
        webTools: runtime,
        roundTimeoutMs: 50,
      }),
    ).rejects.toBeInstanceOf(ProviderAbortError);

    expect(runtime.executed.map((call) => call.id)).toEqual(['hang']);
    expect(runtime.signals[0]?.aborted).toBe(true);
    expect(store.readMonth(MONTH).map((record) => record.role)).toEqual(['user']);
    expect(agent.historyMessageCount).toBe(0);
    expect(readSessionState(sessionsDir, SESSION_KEY)).toBeNull();
  });
});
