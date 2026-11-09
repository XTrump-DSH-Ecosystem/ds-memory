import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Agent } from '../../src/agent/loop.ts';
import { FactsStore } from '../../src/memory/facts.ts';
import { BigramRetriever } from '../../src/memory/retriever/bigram.ts';
import { SelfNoteStore } from '../../src/memory/selfnote.ts';
import { EventStore } from '../../src/memory/store.ts';
import {
  usageOfEvent,
  type ChatEvent,
  type ChatEventStream,
  type ChatRequest,
  type Provider,
} from '../../src/provider/types.ts';

let dir: string;
let clock: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'xds-wiring-'));
  clock = 1_700_000_000_000;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function captureProvider(): { provider: Provider; calls: ChatRequest[] } {
  const calls: ChatRequest[] = [];
  return {
    calls,
    provider: {
      id: 'deepseek',
      chat(req): ChatEventStream {
        calls.push(req);
        return (async function* (): AsyncGenerator<ChatEvent> {
          yield { type: 'text', text: '收到' };
          yield { type: 'done' };
        })();
      },
      usageOf: usageOfEvent,
      async health() {
        return { ok: true, detail: 'fake' };
      },
    },
  };
}

describe('Agent 记忆注入接线', () => {
  it('触发词注入【回忆】，日常轮不注入且静态段逐轮相同', async () => {
    const store = new EventStore({ dir: join(dir, 'events'), now: () => clock });
    store.append({
      id: 'e1',
      src: 'cli',
      sessionKey: 'cli:owner',
      role: 'user',
      text: '上次说的那张 4090 显卡',
      t: clock - 1_000,
    });

    const facts = new FactsStore({
      dir: join(dir, 'facts'),
      halfLifeDays: 45,
      archiveThreshold: 1,
      injectMax: 30,
      injectMaxChars: 900,
      now: () => clock,
      onWarn: () => {},
    });
    facts.upsert('cli:owner', '他不吃香菜', 'preference');

    const { provider, calls } = captureProvider();
    const agent = new Agent({
      provider,
      store,
      persona: '测试人设',
      sessionKey: 'cli:owner',
      now: () => clock,
      memory: {
        facts,
        selfNotes: new SelfNoteStore({
          dir: join(dir, 'selfnotes'),
          max: 40,
          bootstrapLimit: 20,
          now: () => clock,
        }),
        retriever: new BigramRetriever({ store, now: () => clock }),
        recall: { trigger: 'auto', budgetChars: 600, budgetItems: 5 },
      },
    });

    await agent.runTurn('还记得 4090 吗', { signal: new AbortController().signal });
    const firstUser = calls[0]!.messages.at(-1)!.content;
    expect(firstUser).toContain('【回忆】');
    expect(firstUser).toContain('4090');
    expect(firstUser.endsWith('还记得 4090 吗')).toBe(true);

    await agent.runTurn('今天吃什么', { signal: new AbortController().signal });
    const secondUser = calls[1]!.messages.at(-1)!.content;
    expect(secondUser.endsWith('今天吃什么')).toBe(true);

    // facts 未变 → 静态段逐轮完全相同（前缀缓存纪律）。
    expect(calls[0]!.messages[0]!.content).toBe(calls[1]!.messages[0]!.content);
    expect(calls[0]!.messages[0]!.content).toContain('【长期记忆】');
  });

  it('facts 变化后新静态段生效', async () => {
    const store = new EventStore({ dir: join(dir, 'events'), now: () => clock });
    const facts = new FactsStore({
      dir: join(dir, 'facts'),
      halfLifeDays: 45,
      archiveThreshold: 1,
      injectMax: 30,
      injectMaxChars: 900,
      now: () => clock,
      onWarn: () => {},
    });
    const { provider, calls } = captureProvider();
    const agent = new Agent({
      provider,
      store,
      persona: '测试人设',
      sessionKey: 'cli:owner',
      now: () => clock,
      memory: {
        facts,
        selfNotes: new SelfNoteStore({
          dir: join(dir, 'selfnotes'),
          max: 40,
          bootstrapLimit: 20,
          now: () => clock,
        }),
        retriever: new BigramRetriever({ store }),
        recall: { trigger: 'auto', budgetChars: 600, budgetItems: 5 },
      },
    });

    await agent.runTurn('你好', { signal: new AbortController().signal });
    expect(calls[0]!.messages[0]!.content).not.toContain('住在杭州');

    facts.upsert('cli:owner', '他住在杭州', 'identity');
    await agent.runTurn('再说一次你好', { signal: new AbortController().signal });
    expect(calls[1]!.messages[0]!.content).toContain('住在杭州');
  });

  it('trigger=off 时不自动检索', async () => {
    const store = new EventStore({ dir: join(dir, 'events'), now: () => clock });
    store.append({
      id: 'e1',
      src: 'cli',
      sessionKey: 'cli:owner',
      role: 'user',
      text: '4090 显卡',
      t: clock,
    });
    const { provider, calls } = captureProvider();
    const agent = new Agent({
      provider,
      store,
      persona: '测试人设',
      sessionKey: 'cli:owner',
      now: () => clock,
      memory: {
        facts: new FactsStore({
          dir: join(dir, 'facts'),
          halfLifeDays: 45,
          archiveThreshold: 1,
          injectMax: 30,
          injectMaxChars: 900,
          now: () => clock,
        }),
        selfNotes: new SelfNoteStore({
          dir: join(dir, 'selfnotes'),
          max: 40,
          bootstrapLimit: 20,
          now: () => clock,
        }),
        retriever: new BigramRetriever({ store }),
        recall: { trigger: 'off', budgetChars: 600, budgetItems: 5 },
      },
    });

    await agent.runTurn('还记得 4090 吗', { signal: new AbortController().signal });
    expect(calls[0]!.messages.at(-1)!.content.endsWith('还记得 4090 吗')).toBe(true);
  });

  it('重启后 facts 与 selfNote 仍注入', async () => {
    const store = new EventStore({ dir: join(dir, 'events'), now: () => clock });
    const facts = new FactsStore({
      dir: join(dir, 'facts'),
      halfLifeDays: 45,
      archiveThreshold: 1,
      injectMax: 30,
      injectMaxChars: 900,
      now: () => clock,
    });
    const selfNotes = new SelfNoteStore({
      dir: join(dir, 'selfnotes'),
      max: 40,
      bootstrapLimit: 20,
      now: () => clock,
    });
    facts.upsert('cli:owner', '他不吃香菜', 'preference');
    selfNotes.upsert('cli:owner', '我说话要更简短');

    const { provider } = captureProvider();
    const agent = new Agent({
      provider,
      store,
      persona: '测试人设',
      sessionKey: 'cli:owner',
      now: () => clock,
      memory: {
        facts,
        selfNotes,
        retriever: new BigramRetriever({ store }),
        recall: { trigger: 'auto', budgetChars: 600, budgetItems: 5 },
      },
    });

    expect(agent.staticPrompt).toContain('【长期记忆】');
    expect(agent.staticPrompt).toContain('他不吃香菜');
    expect(agent.staticPrompt).toContain('【你对自己的认识】');
    expect(agent.staticPrompt).toContain('我说话要更简短');
  });
});
