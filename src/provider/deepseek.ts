import { redact } from '../util/redact.ts';
import {
  ProviderAbortError,
  ProviderError,
  ProviderTimeoutError,
  usageOfEvent,
  type ChatEvent,
  type ChatEventStream,
  type ProviderMessage,
  type ChatRequest,
  type Provider,
  type ToolCall,
  type ToolCallsEvent,
  type ToolSpec,
  type TokenUsage,
} from './types.ts';

export interface DeepSeekOptions {
  baseUrl: string;
  model: string;
  apiKeyEnv: string;
  timeoutMs: number;
}

/**
 * DeepSeek 官方 REST（OpenAI 兼容）：流式对话、usage 提取与 tool_calls 聚合；
 * 不做重试。
 */
export class DeepSeekProvider implements Provider {
  readonly id = 'deepseek' as const;
  readonly supportsTools = true;
  private readonly options: DeepSeekOptions;

  constructor(options: DeepSeekOptions) {
    this.options = options;
  }

  chat(req: ChatRequest, opts: { signal: AbortSignal }): ChatEventStream {
    return this.stream(req, opts.signal);
  }

  usageOf(event: ChatEvent): TokenUsage | null {
    return usageOfEvent(event);
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    const key = process.env[this.options.apiKeyEnv];
    if (!key) {
      return { ok: false, detail: `缺少环境变量 ${this.options.apiKeyEnv}（请写入 .env）` };
    }
    return { ok: true, detail: `已配置 ${this.options.apiKeyEnv}（P0 未做网络探测）` };
  }

  private async *stream(req: ChatRequest, signal: AbortSignal): AsyncGenerator<ChatEvent> {
    const apiKey = process.env[this.options.apiKeyEnv];
    if (!apiKey) {
      throw new ProviderError(`缺少环境变量 ${this.options.apiKeyEnv}（请写入 .env）`);
    }

    const timeoutController = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // 块间空闲超时：连接/首块前开始计时；进入流式后每收到一个 chunk 重置。
    const arm = (): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timedOut = true;
        timeoutController.abort();
      }, this.options.timeoutMs);
    };
    arm();
    const combined = AbortSignal.any([signal, timeoutController.signal]);
    const url = chatCompletionsUrl(this.options.baseUrl);
    const accumulator: StreamAccumulator = {
      toolCalls: new Map(),
      reasoningContent: '',
      finishReason: null,
    };
    const pendingUsage: TokenUsage[] = [];
    // usage 尾块可能晚于 tool_calls 聚合完成；缓存后统一在 done 前发出。
    const finish = function* (): Generator<ChatEvent> {
      const toolCalls = buildToolCallsEvent(accumulator);
      if (toolCalls) yield toolCalls;
      for (const usage of pendingUsage) yield { type: 'usage', usage };
      yield { type: 'done' };
    };

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(buildRequestBody(this.options.model, req)),
        signal: combined,
      });
      arm();

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new ProviderError(
          `DeepSeek HTTP ${response.status}：${redact(body).slice(0, 300)}`,
          response.status,
        );
      }

      if (!response.body) {
        throw new ProviderError('DeepSeek 响应没有 body（无法流式读取）');
      }

      for await (const data of sseData(response.body, arm)) {
        if (data === '[DONE]') {
          yield* finish();
          return;
        }

        let chunk: unknown;
        try {
          chunk = JSON.parse(data);
        } catch {
          continue; // 跳过坏块，不因单个 chunk 崩掉整轮
        }

        const text = applyChunk(chunk, accumulator);
        if (text) {
          yield { type: 'text', text };
        }

        const usage = chunkUsage(chunk);
        if (usage) {
          pendingUsage.push(usage);
        }
      }

      yield* finish();
    } catch (err) {
      if (signal.aborted) throw new ProviderAbortError();
      if (timedOut) {
        throw new ProviderTimeoutError(
          `超过 ${this.options.timeoutMs}ms 没有收到新数据（块间空闲超时）`,
        );
      }
      if (err instanceof ProviderError) throw err;
      throw new ProviderError(`网络请求失败：${redact(err instanceof Error ? err.message : String(err))}`, undefined);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

function chatCompletionsUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return base.endsWith('/v1') ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
}

interface ToolCallAccumulator {
  id: string;
  name: string;
  argumentsText: string;
}

interface StreamAccumulator {
  toolCalls: Map<number, ToolCallAccumulator>;
  reasoningContent: string;
  finishReason: string | null;
}

const INCOMPLETE_TOOL_CALLS_MESSAGE =
  'DeepSeek tool_calls 流不完整（缺少 id/name 或 finish_reason=tool_calls 但无完整调用）';

function buildRequestBody(model: string, req: ChatRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    messages: req.messages.map(serializeMessage),
    stream: true,
    stream_options: { include_usage: true },
  };
  if (req.tools && req.tools.length > 0) {
    body.tools = req.tools.map(serializeTool);
  }
  return body;
}

function serializeMessage(message: ProviderMessage): Record<string, unknown> {
  if (message.role === 'tool') {
    return {
      role: 'tool',
      content: message.content,
      tool_call_id: message.toolCallId,
    };
  }

  if (message.role === 'assistant' && 'toolCalls' in message) {
    return {
      role: 'assistant',
      content: message.content,
      // thinking mode 回填必需；显式空字符串也满足 API。
      reasoning_content:
        typeof message.reasoningContent === 'string' ? message.reasoningContent : '',
      tool_calls: message.toolCalls.map(serializeToolCall),
    };
  }

  return { role: message.role, content: message.content };
}

function serializeToolCall(call: ToolCall): Record<string, unknown> {
  return {
    id: call.id,
    type: 'function',
    function: {
      name: call.name,
      arguments: call.argumentsText,
    },
  };
}

function serializeTool(tool: ToolSpec): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters ?? { type: 'object', properties: {} },
    },
  };
}

interface FirstChoice {
  delta: Record<string, unknown> | null;
  finishReason: string | null;
}

/** 读取首个 choice；多 choices 时只消费主回复。 */
function firstChoice(chunk: unknown): FirstChoice | null {
  if (!chunk || typeof chunk !== 'object') return null;
  const choices = (chunk as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (!first || typeof first !== 'object') return null;
  const choice = first as Record<string, unknown>;
  const delta = choice.delta;
  return {
    delta:
      delta && typeof delta === 'object'
        ? (delta as Record<string, unknown>)
        : null,
    finishReason:
      typeof choice.finish_reason === 'string' ? choice.finish_reason : null,
  };
}

/** 应用一个 chunk：返回可见 text；同时聚合 tool_calls 与 reasoning_content。 */
function applyChunk(chunk: unknown, accumulator: StreamAccumulator): string | null {
  const choice = firstChoice(chunk);
  if (!choice) return null;
  if (choice.finishReason !== null) {
    accumulator.finishReason = choice.finishReason;
  }

  const delta = choice.delta;
  if (!delta) return null;

  const reasoning = delta.reasoning_content;
  if (typeof reasoning === 'string' && reasoning.length > 0) {
    accumulator.reasoningContent += reasoning;
  }

  const rawToolCalls = delta.tool_calls;
  if (Array.isArray(rawToolCalls)) {
    for (const raw of rawToolCalls) {
      applyToolCallDelta(raw, accumulator.toolCalls);
    }
  }

  const content = delta.content;
  return typeof content === 'string' && content.length > 0 ? content : null;
}

/**
 * DeepSeek 首片带 index/id/type/name；续片 id/type/name 可能是 null 或省略，
 * 只带同一 index 的 arguments 分片。这里只累积非空字符串字段。
 */
function applyToolCallDelta(
  raw: unknown,
  calls: Map<number, ToolCallAccumulator>,
): void {
  if (!raw || typeof raw !== 'object') return;
  const delta = raw as Record<string, unknown>;
  const index = delta.index;
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) return;

  const id = delta.id;
  const fn = delta.function;
  const functionDelta =
    fn && typeof fn === 'object' ? (fn as Record<string, unknown>) : null;
  const name = functionDelta?.name;
  const args = functionDelta?.arguments;

  const hasId = typeof id === 'string' && id.length > 0;
  const hasName = typeof name === 'string' && name.length > 0;
  const hasArgs = typeof args === 'string';
  if (!hasId && !hasName && !hasArgs) return;

  let call = calls.get(index);
  if (!call) {
    call = { id: '', name: '', argumentsText: '' };
    calls.set(index, call);
  }
  if (hasId) call.id = id;
  if (hasName) call.name = name;
  if (hasArgs) call.argumentsText += args;
}

/**
 * 聚合结果一次性发出。
 * 任一累积条目缺 id/name，或 finish_reason=tool_calls 却无完整调用，
 * 都说明流不完整；按契约抛固定 ProviderError，不猜测补全。
 */
function buildToolCallsEvent(
  accumulator: StreamAccumulator,
): ToolCallsEvent | null {
  const toolCalls: ToolCall[] = [];
  const entries = [...accumulator.toolCalls.entries()].sort(([a], [b]) => a - b);
  for (const [, call] of entries) {
    if (call.id.length === 0 || call.name.length === 0) {
      throw new ProviderError(INCOMPLETE_TOOL_CALLS_MESSAGE);
    }
    toolCalls.push({
      id: call.id,
      name: call.name,
      argumentsText: call.argumentsText,
    });
  }
  if (accumulator.finishReason === 'tool_calls' && toolCalls.length === 0) {
    throw new ProviderError(INCOMPLETE_TOOL_CALLS_MESSAGE);
  }
  if (toolCalls.length === 0) return null;
  return {
    type: 'tool_calls',
    toolCalls,
    reasoningContent: accumulator.reasoningContent,
  };
}

function chunkUsage(chunk: unknown): TokenUsage | null {
  if (!chunk || typeof chunk !== 'object') return null;
  const usage = (chunk as { usage?: unknown }).usage;
  if (!usage || typeof usage !== 'object') return null;
  const raw = usage as Record<string, unknown>;
  const promptTokens = Number(raw.prompt_tokens ?? 0);
  const completionTokens = Number(raw.completion_tokens ?? 0);
  if (!Number.isFinite(promptTokens) || !Number.isFinite(completionTokens)) return null;
  const totalTokens = Number(raw.total_tokens ?? promptTokens + completionTokens);
  return {
    promptTokens,
    completionTokens,
    totalTokens: Number.isFinite(totalTokens) ? totalTokens : promptTokens + completionTokens,
  };
}

/**
 * 最小 SSE 解析：按空行切事件，取 data: 行拼接。
 * 兼容 \r\n；坏事件直接跳过。
 * onActivity 在每个网络 chunk 到达时触发（供块间空闲超时重置计时器）。
 */
async function* sseData(
  body: ReadableStream<Uint8Array>,
  onActivity?: () => void,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      onActivity?.();
      // 先拼接再整体归一化：\r\n 可能正好被网络 chunk 边界切开。
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, '\n');

      let sep = buffer.indexOf('\n\n');
      while (sep >= 0) {
        const rawEvent = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const data = extractData(rawEvent);
        if (data !== null) yield data;
        sep = buffer.indexOf('\n\n');
      }
    }

    buffer += decoder.decode();
    buffer = buffer.replace(/\r\n/g, '\n');
    if (buffer.trim().length > 0) {
      const data = extractData(buffer);
      if (data !== null) yield data;
    }
  } finally {
    reader.releaseLock();
  }
}

function extractData(rawEvent: string): string | null {
  const parts: string[] = [];
  for (const line of rawEvent.split('\n')) {
    if (!line.startsWith('data:')) continue;
    parts.push(line.slice(5).replace(/^ /, ''));
  }
  return parts.length > 0 ? parts.join('\n') : null;
}
