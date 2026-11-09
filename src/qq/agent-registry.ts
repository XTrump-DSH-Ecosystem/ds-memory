import { AsyncLocalStorage } from 'node:async_hooks';
import type { Agent, RunTurnOptions, TurnResult } from '../agent/loop.ts';

/** 按 sessionKey 构造 Agent；必须把 sessionKey 传给 Agent（记忆隔离依赖它）。 */
export type AgentFactory = (sessionKey: string) => Agent;

export interface AgentRegistryOptions {
  createAgent: AgentFactory;
}

/**
 * 多会话 Agent 注册表（P2 T4b）。
 *
 * - 一个 sessionKey 只对应一个 Agent，绝不跨 session 复用；
 * - 同一 session 的整回合（runExclusive）串行排队，不同 session 可并行；
 * - 回调内禁止再调用本 registry 的同 session 方法（会立即拒绝，避免自等待死锁）；
 * - 只做 AGENT 调度：不发送、不拆句、不定义线上形状。
 */
export class AgentRegistry {
  private readonly createAgent: AgentFactory;
  private readonly agents = new Map<string, Agent>();
  /** 每个 session 的队尾；无论成功失败都放行下一轮。 */
  private readonly tails = new Map<string, Promise<void>>();
  /** 当前异步上下文正在执行的 session 集合，用于同 session 重入检测。 */
  private readonly activeSessions = new AsyncLocalStorage<ReadonlySet<string>>();

  constructor(options: AgentRegistryOptions) {
    this.createAgent = options.createAgent;
  }

  get sessionCount(): number {
    return this.agents.size;
  }

  get sessionKeys(): string[] {
    return [...this.agents.keys()];
  }

  get(sessionKey: string): Agent | undefined {
    return this.agents.get(sessionKey);
  }

  has(sessionKey: string): boolean {
    return this.agents.has(sessionKey);
  }

  getOrCreate(sessionKey: string): Agent {
    const existing = this.agents.get(sessionKey);
    if (existing) return existing;

    const agent = this.createAgent(sessionKey);
    this.agents.set(sessionKey, agent);
    return agent;
  }

  /**
   * 在指定 session 独占执行一次「整回合」，同 session 按到达顺序串行。
   * T4c 用它在同一串行链上包住 runTurn → send → finalize，
   * 避免上一轮还在发送、下一轮就开始推理。
   *
   * 回调内只使用传入的 agent，禁止再调用本 registry 的同 session
   * runTurn/runExclusive：那会等待自己，因此入口直接拒绝。跨 session 嵌套调用允许。
   *
   * 返回值与失败原样透传。
   */
  runExclusive<T>(sessionKey: string, fn: (agent: Agent) => Promise<T>): Promise<T> {
    const inherited = this.activeSessions.getStore();
    if (inherited?.has(sessionKey)) {
      return Promise.reject(
        new Error(
          `检测到同 session 重入：${sessionKey}；回调内请使用传入的 agent，不要再次调用 registry 的同 session 方法`,
        ),
      );
    }

    const next = new Set(inherited);
    next.add(sessionKey);

    const agent = this.getOrCreate(sessionKey);
    const previous = this.tails.get(sessionKey) ?? Promise.resolve();

    // 上一轮失败也要继续排下一轮：两个分支用同一个执行函数。
    const run = () => this.activeSessions.run(next, () => fn(agent));
    const current = previous.then(run, run);

    // 队尾吞掉结果与异常，只用于串行；调用方拿到的是 current。
    const tail = current.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(sessionKey, tail);
    void tail.then(() => {
      if (this.tails.get(sessionKey) === tail) this.tails.delete(sessionKey);
    });

    return current;
  }

  /**
   * 在指定 session 跑一轮；同 session 的调用按到达顺序串行。
   * opts 原样透传，是否写 user/assistant L0 由调用方决定。
   */
  runTurn(sessionKey: string, userText: string, opts: RunTurnOptions): Promise<TurnResult> {
    return this.runExclusive(sessionKey, (agent) => agent.runTurn(userText, opts));
  }
}
