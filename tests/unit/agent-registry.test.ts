import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Agent } from '../../src/agent/loop.ts';
import { EventStore } from '../../src/memory/store.ts';
import { AgentRegistry } from '../../src/qq/agent-registry.ts';
import {
  ProviderError,
  usageOfEvent,
  type ChatEvent,
  type ChatEventStream,
  type ChatRequest,
  type Provider,
} from '../../src/provider/types.ts';

const NOW = 1_700_000_000_000;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'xds-registry-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function lastUser(req: ChatRequest): string {
  return req.messages.at(-1)!.content.replace(/^【当前时间】[^\n]*\n/, '');
}

interface ActiveCounter {
  count: number;
  max: number;
}

function loggingProvider(input: {
  label: string;
  events: string[];
  active: ActiveCounter;
  delayMs: number;
  requests?: ChatRequest[];
}): Provider {
  return {
    id: 'deepseek',
    chat(req): ChatEventStream {
      input.requests?.push(req);
      return (async function* (): AsyncGenerator<ChatEvent> {
        const user = lastUser(req);
        const tag = `${input.label}:${user}`;
        input.active.count += 1;
        input.active.max = Math.max(input.active.max, input.active.count);
        input.events.push(`start:${tag}`);
        try {
          await new Promise((resolve) => setTimeout(resolve, input.delayMs));
          input.events.push(`end:${tag}`);
          yield { type: 'text', text: `回复:${user}` };
          yield { type: 'done' };
        } finally {
          input.active.count -= 1;
        }
      })();
    },
    usageOf: usageOfEvent,
    async health() {
      return { ok: true, detail: 'fake' };
    },
  };
}

function replyProvider(requests: ChatRequest[]): Provider {
  return {
    id: 'deepseek',
    chat(req): ChatEventStream {
      requests.push(req);
      return (async function* (): AsyncGenerator<ChatEvent> {
        yield { type: 'text', text: `回复:${lastUser(req)}` };
        yield { type: 'done' };
      })();
    },
    usageOf: usageOfEvent,
    async health() {
      return { ok: true, detail: 'fake' };
    },
  };
}

function agentFor(sessionKey: string, provider: Provider, store: EventStore): Agent {
  return new Agent({
    provider,
    store,
    persona: '测试人设',
    sessionKey,
    src: 'qq',
    now: () => NOW,
  });
}

function turnOpts(): { signal: AbortSignal } {
  return { signal: new AbortController().signal };
}

describe('AgentRegistry', () => {
  it('每个 session 独立 Agent，同一 session 复用同一个实例', () => {
    const store = new EventStore({ dir: join(dir, 'events'), now: () => NOW });
    const created: string[] = [];
    const registry = new AgentRegistry({
      createAgent: (sessionKey) => {
        created.push(sessionKey);
        return agentFor(sessionKey, replyProvider([]), store);
      },
    });

    const first = registry.getOrCreate('qq:private:1');
    expect(registry.getOrCreate('qq:private:1')).toBe(first);
    const second = registry.getOrCreate('qq:private:2');

    expect(second).not.toBe(first);
    expect(created).toEqual(['qq:private:1', 'qq:private:2']);
    expect(registry.sessionCount).toBe(2);
    expect(registry.sessionKeys).toEqual(['qq:private:1', 'qq:private:2']);
    expect(registry.has('qq:private:1')).toBe(true);
    expect(registry.get('qq:private:2')).toBe(second);
  });

  it('同一 session 并发 runTurn 串行排队', async () => {
    const store = new EventStore({ dir: join(dir, 'events'), now: () => NOW });
    const events: string[] = [];
    const active: ActiveCounter = { count: 0, max: 0 };
    const provider = loggingProvider({ label: 'A', events, active, delayMs: 10 });
    const registry = new AgentRegistry({
      createAgent: (sessionKey) => agentFor(sessionKey, provider, store),
    });

    const [first, second] = await Promise.all([
      registry.runTurn('qq:private:1', '第一', turnOpts()),
      registry.runTurn('qq:private:1', '第二', turnOpts()),
    ]);

    expect(first.text).toBe('回复:第一');
    expect(second.text).toBe('回复:第二');
    expect(events).toEqual([
      'start:A:第一',
      'end:A:第一',
      'start:A:第二',
      'end:A:第二',
    ]);
    expect(active.max).toBe(1);
  });

  it('runExclusive 回调内同 session runTurn 立即拒绝且链不脏', async () => {
    const store = new EventStore({ dir: join(dir, 'events'), now: () => NOW });
    const requests: ChatRequest[] = [];
    const registry = new AgentRegistry({
      createAgent: (sessionKey) => agentFor(sessionKey, replyProvider(requests), store),
    });

    const outcome = await Promise.race([
      registry
        .runExclusive('qq:private:1', async () => {
          await registry.runTurn('qq:private:1', '内层', turnOpts());
        })
        .then(
          () => 'resolved',
          (error: Error) => `rejected:${error.message}`,
        ),
      new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 250)),
    ]);

    expect(outcome).toContain('rejected:');
    expect(outcome).toContain('重入');
    expect(requests).toEqual([]);

    const later = await registry.runTurn('qq:private:1', '后续', turnOpts());
    expect(later.text).toBe('回复:后续');
    expect(requests).toHaveLength(1);
  });

  it('runExclusive 回调内同 session runExclusive 同样立即拒绝', async () => {
    const store = new EventStore({ dir: join(dir, 'events'), now: () => NOW });
    const registry = new AgentRegistry({
      createAgent: (sessionKey) => agentFor(sessionKey, replyProvider([]), store),
    });

    const outcome = await Promise.race([
      registry
        .runExclusive('qq:private:1', () =>
          registry.runExclusive('qq:private:1', async () => '内层结果'),
        )
        .then(
          () => 'resolved',
          (error: Error) => `rejected:${error.message}`,
        ),
      new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 250)),
    ]);

    expect(outcome).toContain('rejected:');
    expect(outcome).toContain('重入');

    const later = await registry.runExclusive('qq:private:1', async (agent) => {
      const result = await agent.runTurn('后续', turnOpts());
      return result.text;
    });
    expect(later).toBe('回复:后续');
  });

  it('runExclusive 回调内调用另一 session 的 runExclusive 合法', async () => {
    const store = new EventStore({ dir: join(dir, 'events'), now: () => NOW });
    const registry = new AgentRegistry({
      createAgent: (sessionKey) => agentFor(sessionKey, replyProvider([]), store),
    });
    const order: string[] = [];

    const text = await registry.runExclusive('qq:private:1', async () => {
      order.push('s1:begin');
      const inner = await registry.runExclusive('qq:private:2', async (agent) => {
        order.push('s2:begin');
        const result = await agent.runTurn('乙', turnOpts());
        order.push('s2:end');
        return result.text;
      });
      order.push('s1:end');
      return inner;
    });

    expect(text).toBe('回复:乙');
    expect(order).toEqual(['s1:begin', 's2:begin', 's2:end', 's1:end']);
  });

  it('runExclusive 原样返回结果，不同 session 仍并行', async () => {
    const store = new EventStore({ dir: join(dir, 'events'), now: () => NOW });
    const events: string[] = [];
    const active: ActiveCounter = { count: 0, max: 0 };
    const registry = new AgentRegistry({
      createAgent: (sessionKey) =>
        agentFor(
          sessionKey,
          loggingProvider({ label: sessionKey, events, active, delayMs: 20 }),
          store,
        ),
    });

    const tokenA = { session: 'qq:private:1' };
    const tokenB = { session: 'qq:private:2' };
    const [first, second] = await Promise.all([
      registry.runExclusive('qq:private:1', async (agent) => {
        await agent.runTurn('甲', turnOpts());
        return tokenA;
      }),
      registry.runExclusive('qq:private:2', async (agent) => {
        await agent.runTurn('乙', turnOpts());
        return tokenB;
      }),
    ]);

    expect(first).toBe(tokenA);
    expect(second).toBe(tokenB);
    expect(active.max).toBe(2);
    expect(events.slice(0, 2).every((event) => event.startsWith('start:'))).toBe(true);
    const firstEnd = events.findIndex((event) => event.startsWith('end:'));
    expect(firstEnd).toBe(2);
  });

  it('不同 session 的记忆（L0 与 history）互相隔离', async () => {
    const store = new EventStore({ dir: join(dir, 'events'), now: () => NOW });
    const requests = new Map<string, ChatRequest[]>();
    const registry = new AgentRegistry({
      createAgent: (sessionKey) => {
        const own: ChatRequest[] = [];
        requests.set(sessionKey, own);
        return agentFor(sessionKey, replyProvider(own), store);
      },
    });

    await registry.runTurn('qq:private:1', '甲的秘密', turnOpts());
    await registry.runTurn('qq:private:2', '乙的秘密', turnOpts());
    await registry.runTurn('qq:private:1', '继续', turnOpts());

    const firstSessionSecondCall = requests.get('qq:private:1')![1]!;
    const contents = firstSessionSecondCall.messages.map((message) => message.content).join('\n');
    expect(contents).toContain('甲的秘密');
    expect(contents).toContain('回复:甲的秘密');
    expect(contents).not.toContain('乙的秘密');

    const records = store.readMonth('2023-11');
    expect(records.filter((r) => r.sessionKey === 'qq:private:1').map((r) => r.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
    expect(records.filter((r) => r.sessionKey === 'qq:private:2').map((r) => r.role)).toEqual([
      'user',
      'assistant',
    ]);
  });

  it('某一轮失败不会卡死同 session 的后续排队', async () => {
    const store = new EventStore({ dir: join(dir, 'events'), now: () => NOW });
    let calls = 0;
    const provider: Provider = {
      id: 'deepseek',
      chat(): ChatEventStream {
        calls += 1;
        const call = calls;
        return (async function* (): AsyncGenerator<ChatEvent> {
          if (call === 1) throw new ProviderError('模型失败');
          yield { type: 'text', text: '恢复了' };
          yield { type: 'done' };
        })();
      },
      usageOf: usageOfEvent,
      async health() {
        return { ok: true, detail: 'fake' };
      },
    };
    const registry = new AgentRegistry({
      createAgent: (sessionKey) => agentFor(sessionKey, provider, store),
    });

    const results = await Promise.allSettled([
      registry.runTurn('qq:private:1', '失败轮', turnOpts()),
      registry.runTurn('qq:private:1', '恢复轮', turnOpts()),
    ]);

    expect(results[0]!.status).toBe('rejected');
    expect(results[1]!.status).toBe('fulfilled');
    if (results[1]!.status === 'fulfilled') {
      expect(results[1]!.value.text).toBe('恢复了');
    }
  });

  it('runExclusive 把发送收尾纳入同 session 串行', async () => {
    const store = new EventStore({ dir: join(dir, 'events'), now: () => NOW });
    const events: string[] = [];
    const active: ActiveCounter = { count: 0, max: 0 };
    const provider = loggingProvider({ label: 'A', events, active, delayMs: 5 });
    const registry = new AgentRegistry({
      createAgent: (sessionKey) => agentFor(sessionKey, provider, store),
    });

    const first = registry.runExclusive('qq:private:1', async (agent) => {
      events.push('round1:begin');
      const result = await agent.runTurn('第一', turnOpts());
      events.push('round1:send:begin');
      await new Promise((resolve) => setTimeout(resolve, 20));
      events.push('round1:send:end');
      return result.text;
    });
    const second = registry.runExclusive('qq:private:1', async (agent) => {
      events.push('round2:begin');
      const result = await agent.runTurn('第二', turnOpts());
      events.push('round2:end');
      return result.text;
    });

    expect(await Promise.all([first, second])).toEqual(['回复:第一', '回复:第二']);
    expect(events).toEqual([
      'round1:begin',
      'start:A:第一',
      'end:A:第一',
      'round1:send:begin',
      'round1:send:end',
      'round2:begin',
      'start:A:第二',
      'end:A:第二',
      'round2:end',
    ]);
    expect(active.max).toBe(1);
  });

  it('runExclusive 某一轮失败后同 session 链继续', async () => {
    const store = new EventStore({ dir: join(dir, 'events'), now: () => NOW });
    const registry = new AgentRegistry({
      createAgent: (sessionKey) => agentFor(sessionKey, replyProvider([]), store),
    });

    const results = await Promise.allSettled([
      registry.runExclusive('qq:private:1', async () => {
        throw new Error('发送失败');
      }),
      registry.runExclusive('qq:private:1', (agent) => agent.runTurn('恢复轮', turnOpts())),
    ]);

    expect(results[0]!.status).toBe('rejected');
    if (results[0]!.status === 'rejected') {
      expect((results[0]!.reason as Error).message).toBe('发送失败');
    }
    expect(results[1]!.status).toBe('fulfilled');
    if (results[1]!.status === 'fulfilled') {
      expect(results[1]!.value.text).toBe('回复:恢复轮');
    }
  });
});
