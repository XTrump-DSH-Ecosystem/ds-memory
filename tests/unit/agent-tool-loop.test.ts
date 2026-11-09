import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Agent } from '../../src/agent/loop.ts';
import {
  TOOL_LOOP_BUDGET_ERROR_CONTENT,
  TOOL_LOOP_FINAL_ANSWER_INSTRUCTION,
  TOOL_LOOP_FINAL_FALLBACK_TEXT,
  TOOL_LOOP_MAX_MODEL_CALLS,
  TOOL_LOOP_MAX_TOOL_CALLS,
  TOOL_LOOP_TOOL_LIMIT_ERROR_CONTENT,
  runToolLoop,
} from '../../src/agent/tool-loop.ts';
import { EventStore } from '../../src/memory/store.ts';
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

const NOW = 1_700_000_000_000;
const BUDGET_ERROR_CONTENT =
  '[web_tool_error:web_budget_exceeded] 本轮联网结果已达到字符上限。';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'xds-agent-tool-loop-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface ScriptStep {
  events: ChatEvent[];
  errorAfter?: unknown;
}

interface ProviderHarness {
  provider: Provider;
  requests: ChatRequest[];
  signals: AbortSignal[];
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

function scriptedProvider(
  steps: ScriptStep[],
  supportsTools: boolean | undefined = true,
): ProviderHarness {
  const requests: ChatRequest[] = [];
  const signals: AbortSignal[] = [];
  let callIndex = 0;

  const provider: Provider = {
    id: 'deepseek',
    ...(supportsTools === undefined ? {} : { supportsTools }),
    chat(req, opts): ChatEventStream {
      const step = steps[callIndex];
      callIndex += 1;
      if (!step) throw new Error(`unexpected provider call ${callIndex}`);

      signals.push(opts.signal);
      requests.push({
        sessionId: req.sessionId,
        messages: req.messages.map(cloneMessage),
        ...(req.tools
          ? {
              tools: req.tools.map((tool) => ({
                ...tool,
                ...(tool.parameters
                  ? { parameters: structuredClone(tool.parameters) }
                  : {}),
              })),
            }
          : {}),
      });

      return (async function* (): AsyncGenerator<ChatEvent> {
        for (const event of step.events) yield event;
        if (step.errorAfter !== undefined) throw step.errorAfter;
      })();
    },
    usageOf: usageOfEvent,
    async health() {
      return { ok: true, detail: 'fake' };
    },
  };

  return { provider, requests, signals };
}

function toolCall(id: string, name = 'web_search'): ToolCall {
  return {
    id,
    name,
    argumentsText: JSON.stringify({ query: `query-${id}` }),
  };
}

function toolCallsEvent(
  calls: ToolCall[],
  reasoningContent = '',
): ChatEvent {
  return { type: 'tool_calls', toolCalls: calls, reasoningContent };
}

function usage(
  promptTokens: number,
  completionTokens: number,
  totalTokens: number,
): ChatEvent {
  return {
    type: 'usage',
    usage: { promptTokens, completionTokens, totalTokens },
  };
}

type ExecuteBehavior = (
  call: ToolCall,
  callNumber: number,
  options: { signal?: AbortSignal },
) =>
  | WebToolExecutionResult
  | Promise<WebToolExecutionResult>
  | undefined;

class FakeWebToolRuntime implements AgentWebToolRuntime {
  readonly ownerSessionKey: string;
  readonly specs: readonly WebToolSpec[] = [
    {
      name: 'web_search',
      description: 'fake search',
      parameters: { type: 'object' },
    },
    {
      name: 'web_fetch',
      description: 'fake fetch',
      parameters: { type: 'object' },
    },
  ];
  readonly maxResultChars = 12_000;
  readonly maxRoundChars = 24_000;

  beginTurnCalls = 0;
  readonly executed: ToolCall[] = [];
  private readonly behavior: ExecuteBehavior | undefined;

  constructor(behavior?: ExecuteBehavior, ownerSessionKey = 'cli:owner') {
    this.behavior = behavior;
    this.ownerSessionKey = ownerSessionKey;
  }

  beginTurn(): void {
    this.beginTurnCalls += 1;
  }

  async execute(
    call: ToolCall,
    options: { signal?: AbortSignal } = {},
  ): Promise<WebToolExecutionResult> {
    this.executed.push(call);
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

function makeAgent(provider: Provider): {
  agent: Agent;
  store: EventStore;
  sessionsDir: string;
} {
  const store = new EventStore({
    dir: join(dir, 'events'),
    now: () => NOW,
  });
  const sessionsDir = join(dir, 'sessions');
  const agent = new Agent({
    provider,
    store,
    persona: '测试人设',
    sessionKey: 'cli:owner',
    now: () => NOW,
    compaction: {
      enabled: false,
      idleMs: 100_000,
      thresholdTokens: 1_000_000,
      minTurns: 6,
      sessionStateDir: sessionsDir,
    },
    onWarn: () => {},
    onInfo: () => {},
  });
  return { agent, store, sessionsDir };
}

function turnSignals(): AbortSignal {
  return new AbortController().signal;
}

describe('Agent 有界工具循环', () => {
  it('roundTimeoutMs 必须是正整数，并在 provider 调用前失败', async () => {
    const { provider, requests } = scriptedProvider([]);
    const runtime = new FakeWebToolRuntime();

    await expect(
      runToolLoop({
        provider,
        sessionKey: 'cli:owner',
        messages: [],
        webTools: runtime,
        signal: turnSignals(),
        roundTimeoutMs: 0,
      }),
    ).rejects.toThrow(/roundTimeoutMs 必须是正整数/);

    expect(requests).toEqual([]);
    expect(runtime.executed).toEqual([]);
  });

  it('50ms 整轮 deadline 中止 provider，且不落半截持久化', async () => {
    const providerSignals: AbortSignal[] = [];
    const provider: Provider = {
      id: 'deepseek',
      supportsTools: true,
      chat(_req, opts): ChatEventStream {
        providerSignals.push(opts.signal);
        return (async function* (): AsyncGenerator<ChatEvent> {
          await new Promise<void>((_resolve, reject) => {
            const abort = () => reject(new Error('PROVIDER_ABORT_SENTINEL'));
            if (opts.signal.aborted) abort();
            else opts.signal.addEventListener('abort', abort, { once: true });
          });
          yield { type: 'done' };
        })();
      },
      usageOf: usageOfEvent,
      async health() {
        return { ok: true, detail: 'fake' };
      },
    };
    const runtime = new FakeWebToolRuntime();
    const { agent, store, sessionsDir } = makeAgent(provider);

    const error = await agent
      .runTurn('Provider deadline', {
        signal: turnSignals(),
        webTools: runtime,
        roundTimeoutMs: 50,
      })
      .then(
        () => null,
        (reason: unknown) => reason,
      );

    expect(error).toBeInstanceOf(ProviderAbortError);
    expect((error as Error).message).toBe('本轮已中断');
    expect((error as Error).message).not.toContain('PROVIDER_ABORT_SENTINEL');
    expect(providerSignals).toHaveLength(1);
    expect(providerSignals[0]!.aborted).toBe(true);
    expect(runtime.beginTurnCalls).toBe(1);
    expect(runtime.executed).toEqual([]);
    expect(store.readMonth('2023-11').map((record) => record.role)).toEqual([
      'user',
    ]);
    expect(agent.historyMessageCount).toBe(0);
    expect(readSessionState(sessionsDir, 'cli:owner')).toBeNull();
    expect(() => agent.commitAssistant('不应提交')).toThrow(/没有待提交/);
  }, 1_000);

  it('50ms 整轮 deadline 中止 tool，provider/tool 共享 signal 且不落半截持久化', async () => {
    const { provider, signals } = scriptedProvider([
      {
        events: [
          toolCallsEvent([
            {
              id: 'call-deadline',
              name: 'web_search',
              argumentsText: 'ARG_SENTINEL',
            },
          ]),
          { type: 'done' },
        ],
      },
    ]);
    const toolSignals: AbortSignal[] = [];
    const runtime = new FakeWebToolRuntime((call, _callNumber, options) => {
      const signal = options.signal;
      if (!signal) throw new Error('missing signal');
      toolSignals.push(signal);
      return new Promise<WebToolExecutionResult>((resolve) => {
        const finish = () =>
          resolve({
            toolCallId: call.id,
            name: call.name,
            ok: false,
            content: 'TOOL_BODY_SENTINEL',
            error: 'web_aborted',
            truncated: false,
          });
        if (signal.aborted) finish();
        else signal.addEventListener('abort', finish, { once: true });
      });
    });
    const { agent, store, sessionsDir } = makeAgent(provider);

    const error = await agent
      .runTurn('Tool deadline', {
        signal: turnSignals(),
        webTools: runtime,
        roundTimeoutMs: 50,
      })
      .then(
        () => null,
        (reason: unknown) => reason,
      );

    expect(error).toBeInstanceOf(ProviderAbortError);
    expect((error as Error).message).toBe('本轮已中断');
    expect((error as Error).message).not.toContain('ARG_SENTINEL');
    expect((error as Error).message).not.toContain('TOOL_BODY_SENTINEL');
    expect(signals).toHaveLength(1);
    expect(signals[0]!.aborted).toBe(true);
    expect(toolSignals).toHaveLength(1);
    expect(toolSignals[0]!.aborted).toBe(true);
    expect(toolSignals[0]).toBe(signals[0]);
    expect(runtime.beginTurnCalls).toBe(1);
    expect(runtime.executed).toHaveLength(1);
    expect(store.readMonth('2023-11').map((record) => record.role)).toEqual([
      'user',
    ]);
    expect(agent.historyMessageCount).toBe(0);
    expect(readSessionState(sessionsDir, 'cli:owner')).toBeNull();
    expect(() => agent.commitAssistant('不应提交')).toThrow(/没有待提交/);
  }, 1_000);

  it('Provider 不支持 tools 时在 beginTurn/provider/L0 之前失败', async () => {
    const { provider, requests } = scriptedProvider(
      [{ events: [{ type: 'text', text: '不应调用' }, { type: 'done' }] }],
      false,
    );
    const runtime = new FakeWebToolRuntime();
    const { agent, store, sessionsDir } = makeAgent(provider);

    await expect(
      agent.runTurn('不应开始', {
        signal: turnSignals(),
        webTools: runtime,
      }),
    ).rejects.toThrow(/不支持工具调用/);

    expect(runtime.beginTurnCalls).toBe(0);
    expect(requests).toEqual([]);
    expect(store.readMonth('2023-11')).toEqual([]);
    expect(agent.historyMessageCount).toBe(0);
    expect(readSessionState(sessionsDir, 'cli:owner')).toBeNull();
  });

  it('ownerSessionKey 不匹配时在 beginTurn/provider/L0 之前失败', async () => {
    const { provider, requests } = scriptedProvider([
      { events: [{ type: 'text', text: '不应调用' }, { type: 'done' }] },
    ]);
    const runtime = new FakeWebToolRuntime(
      undefined,
      'qq:private:different-owner',
    );
    const { agent, store, sessionsDir } = makeAgent(provider);

    await expect(
      agent.runTurn('不应开始', {
        signal: turnSignals(),
        webTools: runtime,
      }),
    ).rejects.toThrow(/ownerSessionKey.*不匹配/);

    expect(runtime.beginTurnCalls).toBe(0);
    expect(requests).toEqual([]);
    expect(store.readMonth('2023-11')).toEqual([]);
    expect(agent.historyMessageCount).toBe(0);
    expect(readSessionState(sessionsDir, 'cli:owner')).toBeNull();
  });

  it('每回合 beginTurn 恰好一次；纯文本路径仍逐块实时回放且不触碰 runtime', async () => {
    const { provider } = scriptedProvider([
      {
        events: [{ type: 'text', text: '工具轮一' }, { type: 'done' }],
      },
      {
        events: [{ type: 'text', text: '工具轮二' }, { type: 'done' }],
      },
      {
        events: [
          { type: 'text', text: '纯' },
          { type: 'text', text: '文本' },
          { type: 'done' },
        ],
      },
    ]);
    const runtime = new FakeWebToolRuntime();
    const { agent } = makeAgent(provider);

    await agent.runTurn('第一轮', {
      signal: turnSignals(),
      webTools: runtime,
    });
    await agent.runTurn('第二轮', {
      signal: turnSignals(),
      webTools: runtime,
    });

    const chunks: string[] = [];
    const result = await agent.runTurn('纯文本轮', {
      signal: turnSignals(),
      onText: (chunk) => chunks.push(chunk),
    });

    expect(runtime.beginTurnCalls).toBe(2);
    expect(chunks).toEqual(['纯', '文本']);
    expect(result.text).toBe('纯文本');
  });

  it('最多 4 次模型调用，第 4 次不带 tools', async () => {
    const { provider, requests } = scriptedProvider([
      {
        events: [
          toolCallsEvent([toolCall('call-1')]),
          { type: 'done' },
        ],
      },
      {
        events: [
          toolCallsEvent([toolCall('call-2')]),
          { type: 'done' },
        ],
      },
      {
        events: [
          toolCallsEvent([toolCall('call-3')]),
          { type: 'done' },
        ],
      },
      {
        events: [{ type: 'text', text: '最终回答' }, { type: 'done' }],
      },
    ]);
    const runtime = new FakeWebToolRuntime();
    const { agent } = makeAgent(provider);

    const result = await agent.runTurn('查一下', {
      signal: turnSignals(),
      webTools: runtime,
    });

    expect(requests).toHaveLength(TOOL_LOOP_MAX_MODEL_CALLS);
    expect(requests.slice(0, 3).every((request) => request.tools?.length === 2)).toBe(
      true,
    );
    expect(requests[3]!.tools).toBeUndefined();
    expect(runtime.executed.map((call) => call.id)).toEqual([
      'call-1',
      'call-2',
      'call-3',
    ]);
    expect(result.text).toBe('最终回答');
  });

  it('工具轮后的最后一次模型调用注入纯文本收尾指令', async () => {
    const { provider, requests } = scriptedProvider([
      {
        events: [toolCallsEvent([toolCall('call-1')]), { type: 'done' }],
      },
      {
        events: [toolCallsEvent([toolCall('call-2')]), { type: 'done' }],
      },
      {
        events: [toolCallsEvent([toolCall('call-3')]), { type: 'done' }],
      },
      {
        events: [{ type: 'text', text: '最终回答' }, { type: 'done' }],
      },
    ]);
    const { agent } = makeAgent(provider);

    await agent.runTurn('查一下', {
      signal: turnSignals(),
      webTools: new FakeWebToolRuntime(),
    });

    const finalMessages = requests[3]!.messages;
    expect(
      finalMessages.some(
        (message) =>
          message.role === 'system' &&
          message.content === TOOL_LOOP_FINAL_ANSWER_INSTRUCTION,
      ),
    ).toBe(true);
  });

  it('最终文本混有工具标记时丢弃标记行，保留可用正文', async () => {
    const { provider } = scriptedProvider([
      {
        events: [toolCallsEvent([toolCall('call-1')]), { type: 'done' }],
      },
      {
        events: [
          {
            type: 'text',
            text: '答案在这里\n<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="web_fetch">',
          },
          { type: 'done' },
        ],
      },
    ]);
    const { agent } = makeAgent(provider);

    const result = await agent.runTurn('查一下', {
      signal: turnSignals(),
      webTools: new FakeWebToolRuntime(),
    });

    expect(result.text).toBe('答案在这里');
  });

  it('最终文本只有工具标记时返回固定兜底文案', async () => {
    const { provider } = scriptedProvider([
      {
        events: [toolCallsEvent([toolCall('call-1')]), { type: 'done' }],
      },
      {
        events: [
          {
            type: 'text',
            text: '<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="web_fetch">',
          },
          { type: 'done' },
        ],
      },
    ]);
    const { agent } = makeAgent(provider);

    const result = await agent.runTurn('查一下', {
      signal: turnSignals(),
      webTools: new FakeWebToolRuntime(),
    });

    expect(result.text).toBe(TOOL_LOOP_FINAL_FALLBACK_TEXT);
  });

  it('第 5 个及之后的 tool call 不执行，回填固定结构化错误', async () => {
    const calls = Array.from(
      { length: TOOL_LOOP_MAX_TOOL_CALLS + 2 },
      (_value, index) => toolCall(`call-${index + 1}`),
    );
    const { provider, requests } = scriptedProvider([
      {
        events: [toolCallsEvent(calls), { type: 'done' }],
      },
      {
        events: [{ type: 'text', text: '收尾' }, { type: 'done' }],
      },
    ]);
    const runtime = new FakeWebToolRuntime();
    const { agent } = makeAgent(provider);

    const result = await agent.runTurn('一次多搜几个', {
      signal: turnSignals(),
      webTools: runtime,
    });

    expect(runtime.executed.map((call) => call.id)).toEqual([
      'call-1',
      'call-2',
      'call-3',
      'call-4',
    ]);
    const toolMessages = requests[1]!.messages.filter(
      (message) => message.role === 'tool',
    );
    expect(toolMessages).toHaveLength(calls.length);
    expect(toolMessages[4]!.content).toBe(TOOL_LOOP_TOOL_LIMIT_ERROR_CONTENT);
    expect(toolMessages[5]!.content).toBe(TOOL_LOOP_TOOL_LIMIT_ERROR_CONTENT);
    expect(totalToolChars(toolMessages)).toBeLessThanOrEqual(
      runtime.maxRoundChars,
    );
    expect(result.text).toBe('收尾');
  });

  it('第 4 次模型调用即使返回 tool_calls 也不再执行，并确定性返回空串', async () => {
    const { provider, requests } = scriptedProvider([
      {
        events: [
          toolCallsEvent([toolCall('call-1')]),
          { type: 'done' },
        ],
      },
      {
        events: [
          toolCallsEvent([toolCall('call-2')]),
          { type: 'done' },
        ],
      },
      {
        events: [
          toolCallsEvent([toolCall('call-3')]),
          { type: 'done' },
        ],
      },
      {
        events: [
          toolCallsEvent([toolCall('call-4-must-not-run')]),
          { type: 'done' },
        ],
      },
    ]);
    const runtime = new FakeWebToolRuntime();
    const { agent } = makeAgent(provider);

    const result = await agent.runTurn('一直要工具', {
      signal: turnSignals(),
      webTools: runtime,
    });

    expect(requests).toHaveLength(TOOL_LOOP_MAX_MODEL_CALLS);
    expect(requests[3]!.tools).toBeUndefined();
    expect(runtime.executed.map((call) => call.id)).toEqual([
      'call-1',
      'call-2',
      'call-3',
    ]);
    expect(result.text).toBe('');
    expect(result.interrupted).toBe(false);
  });

  it('runtime 返回 web_budget_exceeded 后停止执行，剩余调用复用同一错误正文', async () => {
    const { provider, requests } = scriptedProvider([
      {
        events: [
          toolCallsEvent([toolCall('call-a'), toolCall('call-b')]),
          { type: 'done' },
        ],
      },
      {
        events: [toolCallsEvent([toolCall('call-c')]), { type: 'done' }],
      },
      {
        events: [{ type: 'text', text: '预算后收尾' }, { type: 'done' }],
      },
    ]);
    const runtime = new FakeWebToolRuntime((call) => {
      if (call.id === 'call-b') {
        return {
          toolCallId: call.id,
          name: call.name,
          ok: false,
          content: BUDGET_ERROR_CONTENT,
          error: 'web_budget_exceeded',
          truncated: false,
        };
      }
      return undefined;
    });
    const { agent } = makeAgent(provider);

    const result = await agent.runTurn('控制在预算内', {
      signal: turnSignals(),
      webTools: runtime,
    });

    expect(runtime.executed.map((call) => call.id)).toEqual(['call-a', 'call-b']);

    const firstRoundTools = requests[1]!.messages.filter(
      (message) => message.role === 'tool',
    );
    expect(firstRoundTools.map((message) => message.content)).toEqual([
      'result:call-a',
      BUDGET_ERROR_CONTENT,
    ]);

    const secondRoundTools = requests[2]!.messages.filter(
      (message) => message.role === 'tool',
    );
    expect(secondRoundTools.at(-1)?.content).toBe(BUDGET_ERROR_CONTENT);
    expect(totalToolChars(secondRoundTools)).toBeLessThanOrEqual(
      runtime.maxRoundChars,
    );
    expect(result.text).toBe('预算后收尾');
  });

  it('累计所有 tool 正文；超过 maxRoundChars 后改用固定短预算错误并停止执行', async () => {
    const { provider, requests } = scriptedProvider([
      {
        events: [
          toolCallsEvent([
            toolCall('call-a'),
            toolCall('call-b'),
            toolCall('call-c'),
            toolCall('call-d'),
          ]),
          { type: 'done' },
        ],
      },
      {
        events: [{ type: 'text', text: '预算收尾' }, { type: 'done' }],
      },
    ]);
    const runtime = new FakeWebToolRuntime((call) => ({
      toolCallId: call.id,
      name: call.name,
      ok: true,
      content: 'x'.repeat(9_000),
      truncated: false,
    }));
    const { agent } = makeAgent(provider);

    const result = await agent.runTurn('累计预算', {
      signal: turnSignals(),
      webTools: runtime,
    });

    expect(runtime.executed.map((call) => call.id)).toEqual([
      'call-a',
      'call-b',
      'call-c',
    ]);
    const toolMessages = requests[1]!.messages.filter(
      (message) => message.role === 'tool',
    );
    expect(toolMessages.map((message) => message.content)).toEqual([
      'x'.repeat(9_000),
      'x'.repeat(9_000),
      TOOL_LOOP_BUDGET_ERROR_CONTENT,
      TOOL_LOOP_BUDGET_ERROR_CONTENT,
    ]);
    expect(totalToolChars(toolMessages)).toBeLessThanOrEqual(
      runtime.maxRoundChars,
    );
    expect(result.text).toBe('预算收尾');
  });

  it('单条 tool 结果先按 maxResultChars 截断，并计入整轮总预算', async () => {
    const { provider, requests } = scriptedProvider([
      {
        events: [toolCallsEvent([toolCall('call-large')]), { type: 'done' }],
      },
      {
        events: [{ type: 'text', text: '截断后收尾' }, { type: 'done' }],
      },
    ]);
    const runtime = new FakeWebToolRuntime((call) => ({
      toolCallId: call.id,
      name: call.name,
      ok: true,
      content: '😀'.repeat(20_000),
      truncated: false,
    }));
    const { agent } = makeAgent(provider);

    const result = await agent.runTurn('单条超限', {
      signal: turnSignals(),
      webTools: runtime,
    });

    const toolMessages = requests[1]!.messages.filter(
      (message) => message.role === 'tool',
    );
    expect(toolMessages).toHaveLength(1);
    expect(Array.from(toolMessages[0]!.content)).toHaveLength(
      runtime.maxResultChars,
    );
    expect(toolMessages[0]!.content).toContain(WEB_TOOL_TRUNCATION_MARKER);
    expect(totalToolChars(toolMessages)).toBeLessThanOrEqual(
      runtime.maxRoundChars,
    );
    expect(result.text).toBe('截断后收尾');
  });

  it('错误工具结果原样回填；reasoningContent 原样进入同轮 assistant 消息且不泄露', async () => {
    const reasoning = 'REASONING_SENTINEL_7';
    const toolError =
      '[web_tool_error:web_timeout] 联网请求超时。';
    const { provider, requests } = scriptedProvider([
      {
        events: [
          toolCallsEvent([toolCall('call-error')], reasoning),
          { type: 'done' },
        ],
      },
      {
        events: [{ type: 'text', text: '错误后回答' }, { type: 'done' }],
      },
    ]);
    const runtime = new FakeWebToolRuntime((call) => ({
      toolCallId: call.id,
      name: call.name,
      ok: false,
      content: toolError,
      error: 'web_timeout',
      truncated: false,
    }));
    const { agent, store, sessionsDir } = makeAgent(provider);

    const result = await agent.runTurn('查一下', {
      signal: turnSignals(),
      webTools: runtime,
    });

    const secondMessages = requests[1]!.messages;
    const assistantWithCalls = secondMessages.find(
      (message) => message.role === 'assistant' && 'toolCalls' in message,
    );
    expect(assistantWithCalls).toMatchObject({
      role: 'assistant',
      reasoningContent: reasoning,
      toolCalls: [{ id: 'call-error' }],
    });
    expect(
      secondMessages.find((message) => message.role === 'tool')?.content,
    ).toBe(toolError);

    expect(result.text).toBe('错误后回答');
    expect(store.readMonth('2023-11').map((record) => record.text)).toEqual([
      '查一下',
      '错误后回答',
    ]);
    expect(JSON.stringify(store.readMonth('2023-11'))).not.toContain(reasoning);
    expect(JSON.stringify(readSessionState(sessionsDir, 'cli:owner'))).not.toContain(
      reasoning,
    );
  });

  it('onText 只回放最终轮文本，不泄露工具调用前的内容', async () => {
    const { provider } = scriptedProvider([
      {
        events: [
          { type: 'text', text: '中间草稿不应发送' },
          toolCallsEvent([toolCall('call-1')], '中间思考'),
          { type: 'done' },
        ],
      },
      {
        events: [
          { type: 'text', text: '最终' },
          { type: 'text', text: '回答' },
          { type: 'done' },
        ],
      },
    ]);
    const runtime = new FakeWebToolRuntime();
    const { agent } = makeAgent(provider);
    const chunks: string[] = [];

    const result = await agent.runTurn('流式检查', {
      signal: turnSignals(),
      webTools: runtime,
      onText: (chunk) => chunks.push(chunk),
    });

    expect(result.text).toBe('最终回答');
    expect(chunks).toEqual(['最终回答']);
  });

  it('usage 跨多轮模型调用求和，并累计到 Agent 总量', async () => {
    const { provider } = scriptedProvider([
      {
        events: [
          toolCallsEvent([toolCall('call-1')]),
          usage(10, 5, 15),
          { type: 'done' },
        ],
      },
      {
        events: [
          { type: 'text', text: '完成' },
          usage(20, 7, 27),
          { type: 'done' },
        ],
      },
    ]);
    const runtime = new FakeWebToolRuntime();
    const { agent } = makeAgent(provider);

    const result = await agent.runTurn('统计用量', {
      signal: turnSignals(),
      webTools: runtime,
    });

    const expected: TokenUsage = {
      promptTokens: 30,
      completionTokens: 12,
      totalTokens: 42,
    };
    expect(result.usage).toEqual(expected);
    expect(agent.usageTotals).toEqual(expected);
  });

  it('abort 向外传播，且不写 assistant、history 或会话状态', async () => {
    const controller = new AbortController();
    const { provider } = scriptedProvider([
      {
        events: [toolCallsEvent([toolCall('call-abort')]), { type: 'done' }],
      },
    ]);
    const runtime = new FakeWebToolRuntime((call) => {
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
      agent.runTurn('中止本轮', {
        signal: controller.signal,
        webTools: runtime,
        onText: (chunk) => chunks.push(chunk),
      }),
    ).rejects.toBeInstanceOf(ProviderAbortError);

    expect(runtime.beginTurnCalls).toBe(1);
    expect(store.readMonth('2023-11').map((record) => record.role)).toEqual([
      'user',
    ]);
    expect(agent.historyMessageCount).toBe(0);
    expect(readSessionState(sessionsDir, 'cli:owner')).toBeNull();
    expect(chunks).toEqual([]);
    expect(() => agent.commitAssistant('不应提交')).toThrow(/没有待提交/);
  });

  it('工具中间消息不落 L0、history、state，也不影响 commitAssistant seam', async () => {
    const { provider } = scriptedProvider([
      {
        events: [
          toolCallsEvent([toolCall('call-temp')], '临时思考'),
          { type: 'done' },
        ],
      },
      {
        events: [{ type: 'text', text: '待实际送达' }, { type: 'done' }],
      },
    ]);
    const runtime = new FakeWebToolRuntime(() => ({
      toolCallId: 'call-temp',
      name: 'web_search',
      ok: true,
      content: 'TOOL_BODY_SENTINEL',
      truncated: false,
    }));
    const { agent, store, sessionsDir } = makeAgent(provider);

    const result = await agent.runTurn('发送前检查', {
      signal: turnSignals(),
      webTools: runtime,
      writeAssistantL0: false,
    });

    expect(result.text).toBe('待实际送达');
    expect(store.readMonth('2023-11').map((record) => record.role)).toEqual([
      'user',
    ]);
    expect(agent.historyMessageCount).toBe(1);

    const stateBeforeCommit = readSessionState(sessionsDir, 'cli:owner');
    expect(stateBeforeCommit?.history?.map((message) => message.role)).toEqual([
      'user',
    ]);
    expect(JSON.stringify(stateBeforeCommit)).not.toContain('TOOL_BODY_SENTINEL');
    expect(JSON.stringify(stateBeforeCommit)).not.toContain('临时思考');

    agent.commitAssistant('实际送达');

    expect(store.readMonth('2023-11').map((record) => record.role)).toEqual([
      'user',
      'assistant',
    ]);
    expect(store.readMonth('2023-11')[1]!.text).toBe('实际送达');
    expect(agent.historyMessageCount).toBe(2);
  });

  it('最终轮没有文本时确定性返回空串，不抛错也不编造', async () => {
    const { provider } = scriptedProvider([
      {
        events: [toolCallsEvent([toolCall('call-1')]), { type: 'done' }],
      },
      {
        events: [{ type: 'done' }],
      },
    ]);
    const runtime = new FakeWebToolRuntime();
    const { agent, store } = makeAgent(provider);
    const chunks: string[] = [];

    const result = await agent.runTurn('没有正文', {
      signal: turnSignals(),
      webTools: runtime,
      onText: (chunk) => chunks.push(chunk),
    });

    expect(result.text).toBe('');
    expect(result.interrupted).toBe(false);
    expect(chunks).toEqual([]);
    expect(store.readMonth('2023-11').map((record) => record.role)).toEqual([
      'user',
    ]);
    expect(agent.historyMessageCount).toBe(1);
    expect(() => agent.commitAssistant('不应提交')).toThrow(/没有待提交/);
  });
});

function totalToolChars(
  messages: Extract<ProviderMessage, { role: 'tool' }>[],
): number {
  return messages.reduce(
    (total, message) => total + Array.from(message.content).length,
    0,
  );
}
