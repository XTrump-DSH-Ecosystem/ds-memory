export type Role = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: Role;
  content: string;
}

/** OpenAI 兼容的 function tool 描述。 */
export interface ToolSpec {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  argumentsText: string;
}

/**
 * assistant 回填 tool_calls 时必须携带 reasoningContent（可为空字符串）。
 * DeepSeek thinking mode 缺此字段会返回 HTTP 400；它只用于同轮回填，
 * 不进入 L0/history/日志/QQ 文本。
 */
export interface AssistantToolCallMessage {
  role: 'assistant';
  content: string;
  toolCalls: ToolCall[];
  reasoningContent: string;
}

export interface ToolResultMessage {
  role: 'tool';
  content: string;
  toolCallId: string;
}

/**
 * 仅 Provider 请求层使用的消息。durable `ChatMessage` 仍只允许
 * system/user/assistant，且不携带任何工具字段。
 */
export type ProviderMessage =
  | ChatMessage
  | AssistantToolCallMessage
  | ToolResultMessage;

export interface ChatRequest {
  sessionId: string;
  messages: ProviderMessage[];
  tools?: ToolSpec[];
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ToolCallsEvent {
  type: 'tool_calls';
  toolCalls: ToolCall[];
  reasoningContent: string;
}

export type ChatEvent =
  | { type: 'text'; text: string }
  | { type: 'usage'; usage: TokenUsage }
  | ToolCallsEvent
  | { type: 'done' };

export interface ChatEventStream extends AsyncIterable<ChatEvent> {}

export interface Provider {
  readonly id: 'deepseek' | 'dsh';
  /**
   * 是否支持 function tool calling。既有测试/第三方 Provider 夹具可能未声明，
   * 调用方必须把未声明按 false 处理；DeepSeek=true，DSH=false。
   */
  readonly supportsTools?: boolean;
  chat(req: ChatRequest, opts: { signal: AbortSignal }): ChatEventStream;
  usageOf(event: ChatEvent): TokenUsage | null;
  health(): Promise<{ ok: boolean; detail: string }>;
}

export class ProviderError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
  }
}

/** 用户主动中断（Ctrl+C），上层按「本轮已中断」处理，不当作故障。 */
export class ProviderAbortError extends Error {
  constructor(message = '本轮已中断') {
    super(message);
    this.name = 'ProviderAbortError';
  }
}

/** 请求超时，上层按故障提示。 */
export class ProviderTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderTimeoutError';
  }
}

export function usageOfEvent(event: ChatEvent): TokenUsage | null {
  return event.type === 'usage' ? event.usage : null;
}
