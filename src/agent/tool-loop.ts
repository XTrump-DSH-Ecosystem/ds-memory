import {
  ProviderAbortError,
  type ChatEvent,
  type Provider,
  type ProviderMessage,
  type TokenUsage,
  type ToolCall,
} from '../provider/types.ts';
import { truncateToChars } from '../tools/web/budget.ts';
import { WEB_ROUND_TIMEOUT_MS } from '../tools/web/client.ts';
import type { AgentToolRuntime } from './tool-runtime.ts';

/** 单轮最多调用模型 4 次；第 4 次不再提供工具定义。 */
export const TOOL_LOOP_MAX_MODEL_CALLS = 4;
/** 单轮最多执行 4 个工具调用；后续调用只回填固定错误，不再执行。 */
export const TOOL_LOOP_MAX_TOOL_CALLS = 4;

/** Agent 层工具次数上限的固定结构化错误；不包含任何调用参数。 */
export const TOOL_LOOP_TOOL_LIMIT_ERROR_CONTENT =
  '[agent_tool_error:tool_call_limit] 本轮工具调用次数已达到上限。';

/** 工具消息总字符数超限后使用的固定短错误；不再执行后续工具。 */
export const TOOL_LOOP_BUDGET_ERROR_CONTENT =
  '[web_tool_error:web_budget_exceeded] 工具消息总预算已用尽。';

/** 最后一次模型调用不再带工具，必须明确要求纯文本收尾。 */
export const TOOL_LOOP_FINAL_ANSWER_INSTRUCTION =
  '本轮工具调用已结束。请只基于上面的工具结果用纯文本回答，不要再调用工具，也不要输出任何工具调用标记、XML/DSML 标签或调用示例。资料不足就直说不足。';

/** 模型仍输出工具调用标记且没有可 salvage 的正文时的固定兜底。 */
export const TOOL_LOOP_FINAL_FALLBACK_TEXT =
  '这轮查到的资料还不够整理成最终回答，请再问一次或换个问法。';

const TOOL_MARKUP_MARKER = '｜｜DSML｜｜';

export interface ToolLoopOptions {
  provider: Provider;
  sessionKey: string;
  messages: ProviderMessage[];
  /** 已合并的联网/记忆工具 runtime；本循环不关心具体工具来源。 */
  webTools: AgentToolRuntime;
  signal: AbortSignal;
  /** 整轮 deadline；仅内部/测试注入，默认 120000ms。 */
  roundTimeoutMs?: number;
}

export interface ToolLoopResult {
  /** 只包含最后一轮模型输出的可见文本；没有最终文本时为空串。 */
  text: string;
  /** 本次工具循环内所有模型调用的 usage 求和；没有 usage 时为 null。 */
  usage: TokenUsage | null;
}

/**
 * 有界工具循环。
 *
 * - messages 是仅在本轮内存在的临时数组；工具消息不会返回给调用方；
 * - 工具执行委托 AgentWebToolRuntime；本函数另按字符数硬限所有 tool 正文，
 *   防止错误/限制文本突破 runtime 的成功结果预算；
 * - 中途 abort 以 ProviderAbortError 向外传播，不生成半截最终文本。
 */
export async function runToolLoop(options: ToolLoopOptions): Promise<ToolLoopResult> {
  const roundTimeoutMs = options.roundTimeoutMs ?? WEB_ROUND_TIMEOUT_MS;
  if (!Number.isInteger(roundTimeoutMs) || roundTimeoutMs <= 0) {
    throw new Error('roundTimeoutMs 必须是正整数');
  }

  const roundController = new AbortController();
  const roundSignal = AbortSignal.any([
    options.signal,
    roundController.signal,
  ]);
  const roundTimer = setTimeout(() => roundController.abort(), roundTimeoutMs);

  try {
    return await executeToolLoop(options, roundSignal);
  } catch (err) {
    if (roundSignal.aborted) throw new ProviderAbortError();
    throw err;
  } finally {
    clearTimeout(roundTimer);
  }
}

async function executeToolLoop(
  options: ToolLoopOptions,
  signal: AbortSignal,
): Promise<ToolLoopResult> {
  const messages = [...options.messages];
  let usage: TokenUsage | null = null;
  let executedToolCalls = 0;
  let toolMessageChars = 0;
  let budgetExhausted = false;
  let budgetErrorContent: string | null = null;
  const fixedBudgetErrorContent = truncateToChars(
    TOOL_LOOP_BUDGET_ERROR_CONTENT,
    options.webTools.maxResultChars,
  ).text;

  const appendToolMessage = (call: ToolCall, content: string): void => {
    // 单结果由 Agent 再兜底一次，绝不信任自定义 runtime 的返回长度。
    let finalContent = truncateToChars(
      content,
      options.webTools.maxResultChars,
    ).text;
    let finalChars = countChars(finalContent);

    if (toolMessageChars + finalChars > options.webTools.maxRoundChars) {
      // 所有 tool 正文（含错误/限制文本）共享硬预算。
      budgetExhausted = true;
      budgetErrorContent = fixedBudgetErrorContent;
      finalContent = fixedBudgetErrorContent;
      finalChars = countChars(finalContent);
    }

    if (toolMessageChars + finalChars > options.webTools.maxRoundChars) {
      // 极小自定义预算下连固定错误也放不下；用空正文保证总预算不被突破。
      finalContent = '';
      finalChars = 0;
    }

    toolMessageChars += finalChars;
    messages.push({
      role: 'tool',
      toolCallId: call.id,
      content: finalContent,
    });
  };

  for (
    let modelCall = 1;
    modelCall <= TOOL_LOOP_MAX_MODEL_CALLS;
    modelCall += 1
  ) {
    throwIfAborted(signal);

    const roundText: string[] = [];
    const roundToolCalls: ToolCall[] = [];
    let roundReasoningContent = '';
    let sawToolCallsEvent = false;

    if (
      modelCall === TOOL_LOOP_MAX_MODEL_CALLS &&
      executedToolCalls > 0
    ) {
      messages.push({
        role: 'system',
        content: TOOL_LOOP_FINAL_ANSWER_INSTRUCTION,
      });
    }

    const request =
      modelCall < TOOL_LOOP_MAX_MODEL_CALLS
        ? {
            sessionId: options.sessionKey,
            messages: [...messages],
            tools: [...options.webTools.specs],
          }
        : {
            sessionId: options.sessionKey,
            messages: [...messages],
          };

    for await (const event of options.provider.chat(request, { signal })) {
      if (event.type === 'text') {
        roundText.push(event.text);
        continue;
      }
      if (event.type === 'usage') {
        const eventUsage = options.provider.usageOf(event);
        if (eventUsage) usage = addUsage(usage, eventUsage);
        continue;
      }
      if (event.type === 'tool_calls') {
        if (!sawToolCallsEvent) {
          roundReasoningContent =
            typeof event.reasoningContent === 'string'
              ? event.reasoningContent
              : '';
          sawToolCallsEvent = true;
        }
        roundToolCalls.push(...event.toolCalls);
      }
    }

    throwIfAborted(signal);

    const text = cleanFinalText(roundText.join(''));
    if (
      roundToolCalls.length === 0 ||
      modelCall >= TOOL_LOOP_MAX_MODEL_CALLS
    ) {
      return { text, usage };
    }

    messages.push({
      role: 'assistant',
      content: text,
      toolCalls: roundToolCalls,
      reasoningContent: roundReasoningContent,
    });

    for (const call of roundToolCalls) {
      let content: string;
      if (budgetExhausted) {
        content = budgetErrorContent ?? TOOL_LOOP_BUDGET_ERROR_CONTENT;
      } else if (executedToolCalls >= TOOL_LOOP_MAX_TOOL_CALLS) {
        content = TOOL_LOOP_TOOL_LIMIT_ERROR_CONTENT;
      } else {
        executedToolCalls += 1;
        const result = await options.webTools.execute(call, { signal });
        throwIfAborted(signal);
        if (result.error === 'web_aborted') throw new ProviderAbortError();
        content = result.content;
        if (result.error === 'web_budget_exceeded') {
          // 预算错误由 runtime 决定；后续调用复用完全相同的错误正文。
          budgetExhausted = true;
          budgetErrorContent = result.content;
        }
      }

      appendToolMessage(call, content);
    }
  }

  return { text: '', usage };
}

function countChars(text: string): number {
  return Array.from(text).length;
}

/**
 * DeepSeek 在工具预算耗尽后偶尔把内部工具调用标记当正文吐出来。
 * 先按行丢弃标记行；若没有留下可用正文，返回固定兜底，绝不把原始标记发给用户。
 */
function cleanFinalText(text: string): string {
  if (!text.includes(TOOL_MARKUP_MARKER)) return text;
  const kept = text
    .split(/\r?\n/)
    .filter((line) => !line.includes(TOOL_MARKUP_MARKER))
    .join('\n')
    .trim();
  return kept.length > 0 ? kept : TOOL_LOOP_FINAL_FALLBACK_TEXT;
}

function addUsage(
  total: TokenUsage | null,
  usage: TokenUsage,
): TokenUsage {
  if (total === null) return { ...usage };
  return {
    promptTokens: total.promptTokens + usage.promptTokens,
    completionTokens: total.completionTokens + usage.completionTokens,
    totalTokens: total.totalTokens + usage.totalTokens,
  };
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new ProviderAbortError();
}
