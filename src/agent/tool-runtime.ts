import type { ToolCall, ToolSpec } from '../provider/types.ts';

/** 所有工具 runtime 的最小公共接口；联网、记忆等模块只提供 specs 与执行。 */
export interface AgentToolRuntime {
  readonly ownerSessionKey: string;
  readonly specs: readonly ToolSpec[];
  /** 单个 tool 消息的字符硬上限。 */
  readonly maxResultChars: number;
  /** 整轮所有 tool 消息的字符硬上限。 */
  readonly maxRoundChars: number;
  beginTurn(): void;
  execute(
    call: ToolCall,
    options?: { signal?: AbortSignal },
  ): Promise<{ content: string; error?: string }>;
}

/**
 * 合并多个工具 runtime。工具名必须全局唯一；预算取最紧的上限。
 * 任一 runtime 的 ownerSessionKey 不一致直接抛错，避免跨会话越权。
 */
export function mergeToolRuntimes(
  runtimes: readonly (AgentToolRuntime | undefined)[],
): AgentToolRuntime | undefined {
  const active = runtimes.filter(
    (runtime): runtime is AgentToolRuntime => runtime !== undefined,
  );
  if (active.length === 0) return undefined;
  if (active.length === 1) return active[0];

  const ownerSessionKey = active[0]!.ownerSessionKey;
  const owners = new Map<string, AgentToolRuntime>();
  const specs: ToolSpec[] = [];

  for (const runtime of active) {
    if (runtime.ownerSessionKey !== ownerSessionKey) {
      throw new Error('工具 runtime 的会话不一致');
    }
    for (const spec of runtime.specs) {
      if (owners.has(spec.name)) {
        throw new Error(`工具名重复：${spec.name}`);
      }
      owners.set(spec.name, runtime);
      specs.push(spec);
    }
  }

  return {
    ownerSessionKey,
    specs,
    maxResultChars: Math.min(...active.map((runtime) => runtime.maxResultChars)),
    maxRoundChars: Math.min(...active.map((runtime) => runtime.maxRoundChars)),
    beginTurn() {
      for (const runtime of active) runtime.beginTurn();
    },
    async execute(call, options) {
      const runtime = owners.get(call.name);
      if (!runtime) {
        return {
          content: '[agent_tool_error:unknown_tool] 未知工具。',
          error: 'unknown_tool',
        };
      }
      return runtime.execute(call, options);
    },
  };
}
