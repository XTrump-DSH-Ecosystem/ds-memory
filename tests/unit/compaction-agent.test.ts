import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Agent } from '../../src/agent/loop.ts';
import { FactsStore } from '../../src/memory/facts.ts';
import { BigramRetriever } from '../../src/memory/retriever/bigram.ts';
import { SelfNoteStore } from '../../src/memory/selfnote.ts';
import { EventStore } from '../../src/memory/store.ts';
import {
  ProviderAbortError,
  usageOfEvent,
  type ChatEvent,
  type ChatEventStream,
  type Provider,
} from '../../src/provider/types.ts';

const IDLE_MS = 100_000;
const THRESHOLD_TOKENS = 10;

let dir: string;
let clock: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'xds-compact-'));
  clock = 1_700_000_000_000;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface ProviderHarness {
  provider: Provider;
  stats: { normal: number; compaction: number };
}

function makeProvider(compactionText: string): ProviderHarness {
  const stats = { normal: 0, compaction: 0 };
  const provider: Provider = {
    id: 'deepseek',
    chat(req): ChatEventStream {
      const isCompaction = (req.messages[0]?.content ?? '').includes('记忆整理');
      if (isCompaction) stats.compaction += 1;
      else stats.normal += 1;
      const text = isCompaction ? compactionText : '收到';
      return (async function* (): AsyncGenerator<ChatEvent> {
        yield { type: 'text', text };
        yield { type: 'done' };
      })();
    },
    usageOf: usageOfEvent,
    async health() {
      return { ok: true, detail: 'fake' };
    },
  };
  return { provider, stats };
}

function makeAbortableCompactionProvider(compactionText: string): {
  provider: Provider;
  compactionStarted: Promise<void>;
} {
  let markStarted!: () => void;
  const compactionStarted = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const provider: Provider = {
    id: 'deepseek',
    chat(req, opts): ChatEventStream {
      const isCompaction = (req.messages[0]?.content ?? '').includes('记忆整理');
      if (!isCompaction) {
        return (async function* (): AsyncGenerator<ChatEvent> {
          yield { type: 'text', text: '收到' };
          yield { type: 'done' };
        })();
      }
      return (async function* (): AsyncGenerator<ChatEvent> {
        yield { type: 'text', text: compactionText };
        markStarted();
        await new Promise<void>((resolve) => {
          if (opts.signal.aborted) {
            resolve();
            return;
          }
          opts.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        throw new ProviderAbortError();
      })();
    },
    usageOf: usageOfEvent,
    async health() {
      return { ok: true, detail: 'fake' };
    },
  };
  return { provider, compactionStarted };
}

function makeFacts(factsDir: string): FactsStore {
  return new FactsStore({
    dir: factsDir,
    halfLifeDays: 45,
    archiveThreshold: 1,
    injectMax: 30,
    injectMaxChars: 900,
    now: () => clock,
    onWarn: () => {},
  });
}

function makeAgent(
  provider: Provider,
  facts: FactsStore,
  selfNotes: SelfNoteStore,
  compactionOverrides: Partial<{ thresholdTokens: number; minTurns: number }> = {},
  harness: {
    sessionStateDir?: string;
    compactionEnabled?: boolean;
    onWarn?: (message: string) => void;
  } = {},
): Agent {
  const store = new EventStore({ dir: join(dir, 'events'), now: () => clock });
  return new Agent({
    provider,
    store,
    persona: '测试人设',
    sessionKey: 'cli:owner',
    now: () => clock,
    memory: {
      facts,
      selfNotes,
      retriever: new BigramRetriever({ store, now: () => clock }),
      recall: { trigger: 'auto', budgetChars: 600, budgetItems: 5 },
    },
    compaction: {
      enabled: harness.compactionEnabled ?? true,
      idleMs: IDLE_MS,
      thresholdTokens: THRESHOLD_TOKENS,
      minTurns: 6,
      ...compactionOverrides,
      sessionStateDir: harness.sessionStateDir ?? join(dir, 'sessions'),
    },
    onWarn: harness.onWarn ?? (() => {}),
    onInfo: () => {},
  });
}

/** 连续跑 3 轮攒历史（时钟不动 → 不满足闲置条件）。 */
async function buildHistory(agent: Agent): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await agent.runTurn(`第${i}轮`.repeat(20), { signal: new AbortController().signal });
  }
}

describe('Agent 压缩（ADR-D6）', () => {
  it('闲置前不压缩；闲置后压缩：记忆先写，再截断历史', async () => {
    const facts = makeFacts(join(dir, 'facts'));
    const selfNotes = new SelfNoteStore({
      dir: join(dir, 'selfnotes'),
      max: 40,
      bootstrapLimit: 20,
      now: () => clock,
    });
    const { provider, stats } = makeProvider(
      '{"facts":[{"text":"他不吃香菜","tag":"preference"}],"selfNotes":["我该更简短"],"summary":"聊了香菜与显卡"}',
    );
    const agent = makeAgent(provider, facts, selfNotes);

    await buildHistory(agent);
    expect(agent.historyMessageCount).toBe(6);
    expect(stats.compaction).toBe(0);

    clock += IDLE_MS * 2;
    await agent.runTurn('第四条', { signal: new AbortController().signal });

    expect(stats.compaction).toBe(1);
    expect(agent.historyMessageCount).toBe(6); // 6 → 保留 4 → 本轮再加 2
    expect(agent.factsCount).toBe(1);
    expect(agent.selfNoteCount).toBe(1);
    expect(agent.hasSummary).toBe(true);

    const stateFile = join(dir, 'sessions', 'cli_owner.json');
    expect(existsSync(stateFile)).toBe(true);
    expect(readFileSync(stateFile, 'utf8')).toContain('聊了香菜与显卡');
  });

  it('高 token 阈值下仍可由 minTurns 触发，避免 facts/selfNote 永远不落盘', async () => {
    const facts = makeFacts(join(dir, 'facts'));
    const selfNotes = new SelfNoteStore({
      dir: join(dir, 'selfnotes'),
      max: 40,
      bootstrapLimit: 20,
      now: () => clock,
    });
    const { provider, stats } = makeProvider(
      '{"facts":[{"text":"他在准备考试","tag":"identity"}],"selfNotes":["我要记住复习进度"],"summary":"聊了考试"}',
    );
    const agent = makeAgent(provider, facts, selfNotes, {
      thresholdTokens: 1_000_000,
      minTurns: 3,
    });

    await buildHistory(agent);
    expect(stats.compaction).toBe(0);

    clock += IDLE_MS * 2;
    await agent.runTurn('第四条', { signal: new AbortController().signal });

    expect(stats.compaction).toBe(1);
    expect(agent.factsCount).toBe(1);
    expect(agent.selfNoteCount).toBe(1);
    expect(agent.hasSummary).toBe(true);

    // 整理后计数归零；下一次闲置不能立刻重复消耗模型调用。
    clock += IDLE_MS * 2;
    await agent.runTurn('第五条', { signal: new AbortController().signal });
    expect(stats.compaction).toBe(1);

    clock += IDLE_MS * 2;
    await agent.runTurn('第六条', { signal: new AbortController().signal });
    expect(stats.compaction).toBe(1);

    clock += IDLE_MS * 2;
    await agent.runTurn('第七条', { signal: new AbortController().signal });
    expect(stats.compaction).toBe(2);
  });

  it('记忆写入失败 → 本次放弃压缩，历史保持原样', async () => {
    const broken = join(dir, 'facts-is-a-file');
    writeFileSync(broken, 'not a directory', 'utf8');
    const facts = makeFacts(broken);
    const selfNotes = new SelfNoteStore({
      dir: join(dir, 'selfnotes'),
      max: 40,
      bootstrapLimit: 20,
      now: () => clock,
    });
    const { provider } = makeProvider(
      '{"facts":[{"text":"他不吃香菜","tag":"preference"}],"selfNotes":[],"summary":"摘要"}',
    );
    const agent = makeAgent(provider, facts, selfNotes);

    await buildHistory(agent);
    clock += IDLE_MS * 2;
    await agent.runTurn('第四条', { signal: new AbortController().signal });

    expect(agent.historyMessageCount).toBe(8); // 没有截断
    expect(agent.hasSummary).toBe(false);
    expect(agent.factsCount).toBe(0);
  });

  it('摘要状态写盘失败 → 本次放弃压缩，历史保持原样', async () => {
    const facts = makeFacts(join(dir, 'facts'));
    const selfNotes = new SelfNoteStore({
      dir: join(dir, 'selfnotes'),
      max: 40,
      bootstrapLimit: 20,
      now: () => clock,
    });
    const blocker = join(dir, 'sessions-is-a-file');
    writeFileSync(blocker, 'not a directory', 'utf8');
    const { provider } = makeProvider(
      '{"facts":[{"text":"他不吃香菜","tag":"preference"}],"selfNotes":[],"summary":"摘要"}',
    );
    const agent = makeAgent(provider, facts, selfNotes, {}, {
      sessionStateDir: blocker,
    });

    await buildHistory(agent);
    clock += IDLE_MS * 2;
    await agent.runTurn('第四条', { signal: new AbortController().signal });

    expect(agent.historyMessageCount).toBe(8); // 没有截断
    expect(agent.hasSummary).toBe(false);
    expect(agent.factsCount).toBe(1); // 既有顺序：记忆先写，摘要失败不回滚
  });

  it('JSON 解析失败 → 放弃且不连续重试', async () => {
    const facts = makeFacts(join(dir, 'facts'));
    const selfNotes = new SelfNoteStore({
      dir: join(dir, 'selfnotes'),
      max: 40,
      bootstrapLimit: 20,
      now: () => clock,
    });
    const { provider, stats } = makeProvider('我不想输出 JSON');
    const agent = makeAgent(provider, facts, selfNotes);

    await buildHistory(agent);
    clock += IDLE_MS * 2;
    await agent.runTurn('第四条', { signal: new AbortController().signal });

    expect(stats.compaction).toBe(1);
    expect(agent.historyMessageCount).toBe(8);

    // 紧接着下一条消息：仍在防抖窗口内，不再尝试。
    await agent.runTurn('第五条', { signal: new AbortController().signal });
    expect(stats.compaction).toBe(1);

    // 过了闲置窗口才允许再试一次。
    clock += IDLE_MS * 2;
    await agent.runTurn('第六条', { signal: new AbortController().signal });
    expect(stats.compaction).toBe(2);
  });

  it('摘要持久化，重启后能从 state 恢复', async () => {
    const factsDir = join(dir, 'facts');
    const notesDir = join(dir, 'selfnotes');
    const facts = makeFacts(factsDir);
    const selfNotes = new SelfNoteStore({
      dir: notesDir,
      max: 40,
      bootstrapLimit: 20,
      now: () => clock,
    });
    const { provider } = makeProvider(
      '{"facts":[{"text":"他住在杭州","tag":"identity"}],"selfNotes":[],"summary":"聊了住址"}',
    );
    const agent = makeAgent(provider, facts, selfNotes);

    await buildHistory(agent);
    clock += IDLE_MS * 2;
    await agent.runTurn('第四条', { signal: new AbortController().signal });
    expect(agent.hasSummary).toBe(true);

    // 模拟重启：新进程、新 store 实例，从磁盘读回摘要 / facts。
    const restartedFacts = makeFacts(factsDir);
    const restartedNotes = new SelfNoteStore({
      dir: notesDir,
      max: 40,
      bootstrapLimit: 20,
      now: () => clock,
    });
    const { provider: restartedProvider } = makeProvider('');
    const restarted = makeAgent(restartedProvider, restartedFacts, restartedNotes);

    expect(restarted.hasSummary).toBe(true);
    expect(restarted.staticPrompt).toContain('聊了住址');
    expect(restarted.staticPrompt).toContain('他住在杭州');
    expect(restarted.factsCount).toBe(1);
  });

  it('重启恢复历史/整理计数/lastTurnAt，下一次闲置继续压缩', async () => {
    const factsDir = join(dir, 'facts');
    const notesDir = join(dir, 'selfnotes');
    const facts = makeFacts(factsDir);
    const selfNotes = new SelfNoteStore({
      dir: notesDir,
      max: 40,
      bootstrapLimit: 20,
      now: () => clock,
    });
    const first = makeProvider(
      '{"facts":[{"text":"他在准备考试","tag":"identity"}],"selfNotes":[],"summary":"聊了考试"}',
    );
    const agent = makeAgent(first.provider, facts, selfNotes);

    for (let i = 0; i < 6; i += 1) {
      await agent.runTurn(`整理前第${i}轮`.repeat(20), {
        signal: new AbortController().signal,
      });
    }
    expect(agent.historyMessageCount).toBe(12);

    const statePath = join(dir, 'sessions', 'cli_owner.json');
    const persisted = JSON.parse(readFileSync(statePath, 'utf8')) as {
      history: unknown[];
      turnsSinceCompaction: number;
      lastTurnAt: string;
    };
    expect(persisted.history).toHaveLength(12);
    expect(persisted.turnsSinceCompaction).toBe(6);
    expect(Number.isFinite(Date.parse(persisted.lastTurnAt))).toBe(true);

    const restartedFacts = makeFacts(factsDir);
    const restartedNotes = new SelfNoteStore({
      dir: notesDir,
      max: 40,
      bootstrapLimit: 20,
      now: () => clock,
    });
    const second = makeProvider(
      '{"facts":[{"text":"他考试通过了","tag":"identity"}],"selfNotes":[],"summary":"考试结束"}',
    );
    const restarted = makeAgent(second.provider, restartedFacts, restartedNotes);
    expect(restarted.historyMessageCount).toBe(12);
    expect(restarted.hasSummary).toBe(false);

    clock += IDLE_MS * 2;
    await restarted.runTurn('重启后新消息', { signal: new AbortController().signal });

    expect(second.stats.compaction).toBe(1);
    expect(restarted.hasSummary).toBe(true);
    expect(restarted.historyMessageCount).toBe(6);
    expect(restarted.staticPrompt).toContain('考试结束');
  });

  it('普通状态写盘失败只告警一次，聊天继续', async () => {
    const facts = makeFacts(join(dir, 'facts'));
    const selfNotes = new SelfNoteStore({
      dir: join(dir, 'selfnotes'),
      max: 40,
      bootstrapLimit: 20,
      now: () => clock,
    });
    const blocker = join(dir, 'sessions-is-a-file');
    writeFileSync(blocker, 'not a directory', 'utf8');
    const warnings: string[] = [];
    const { provider } = makeProvider('');
    const agent = makeAgent(provider, facts, selfNotes, {}, {
      sessionStateDir: blocker,
      onWarn: (message) => warnings.push(message),
    });

    const first = await agent.runTurn('第一轮', { signal: new AbortController().signal });
    const second = await agent.runTurn('第二轮', { signal: new AbortController().signal });
    expect(first.text).toBe('收到');
    expect(second.text).toBe('收到');
    expect(warnings.filter((message) => message.includes('会话状态写入失败'))).toHaveLength(1);
  });

  it('commitAssistant 后的实际送达内容也会写进会话状态，重启可恢复', async () => {
    const facts = makeFacts(join(dir, 'facts'));
    const selfNotes = new SelfNoteStore({
      dir: join(dir, 'selfnotes'),
      max: 40,
      bootstrapLimit: 20,
      now: () => clock,
    });
    const { provider } = makeProvider('');
    const agent = makeAgent(provider, facts, selfNotes);

    await agent.runTurn('需要发送的内容', {
      signal: new AbortController().signal,
      writeAssistantL0: false,
    });
    agent.commitAssistant('实际送达的回复');

    const statePath = join(dir, 'sessions', 'cli_owner.json');
    const persisted = JSON.parse(readFileSync(statePath, 'utf8')) as {
      history: Array<{ role: string; content: string }>;
    };
    expect(persisted.history).toEqual([
      { role: 'user', content: '需要发送的内容' },
      { role: 'assistant', content: '实际送达的回复' },
    ]);

    const restarted = makeAgent(
      makeProvider('').provider,
      makeFacts(join(dir, 'facts')),
      new SelfNoteStore({
        dir: join(dir, 'selfnotes'),
        max: 40,
        bootstrapLimit: 20,
        now: () => clock,
      }),
    );
    expect(restarted.historyMessageCount).toBe(2);
  });
});

describe('Agent 手动整理', () => {
  it('consolidateNow 绕过闲置与 minTurns，成功后写记忆/摘要并归零计数', async () => {
    const facts = makeFacts(join(dir, 'facts'));
    const selfNotes = new SelfNoteStore({
      dir: join(dir, 'selfnotes'),
      max: 40,
      bootstrapLimit: 20,
      now: () => clock,
    });
    const { provider, stats } = makeProvider(
      '{"facts":[{"text":"他喜欢喝咖啡","tag":"preference"}],"selfNotes":["我要记住他的口味"],"summary":"聊了咖啡"}',
    );
    const agent = makeAgent(provider, facts, selfNotes);

    await agent.runTurn('我喜欢喝咖啡', { signal: new AbortController().signal });
    expect(stats.compaction).toBe(0);

    const result = await agent.consolidateNow();
    expect(result).toEqual({ ok: true, facts: 1, selfNotes: 1 });
    expect(stats.compaction).toBe(1);
    expect(agent.hasSummary).toBe(true);
    expect(agent.factsCount).toBe(1);
    expect(agent.selfNoteCount).toBe(1);

    const persisted = JSON.parse(
      readFileSync(join(dir, 'sessions', 'cli_owner.json'), 'utf8'),
    ) as { summary: string; turnsSinceCompaction: number };
    expect(persisted.summary).toBe('聊了咖啡');
    expect(persisted.turnsSinceCompaction).toBe(0);
  });

  it('没有历史或整理失败时返回原因，且不截断历史', async () => {
    const facts = makeFacts(join(dir, 'facts'));
    const selfNotes = new SelfNoteStore({
      dir: join(dir, 'selfnotes'),
      max: 40,
      bootstrapLimit: 20,
      now: () => clock,
    });
    const { provider, stats } = makeProvider('不是 JSON');
    const agent = makeAgent(provider, facts, selfNotes);

    expect(await agent.consolidateNow()).toEqual({
      ok: false,
      reason: '没有可整理的对话历史',
    });

    await agent.runTurn('第一轮', { signal: new AbortController().signal });
    await agent.runTurn('第二轮', { signal: new AbortController().signal });
    expect(agent.historyMessageCount).toBe(4);

    const result = await agent.consolidateNow();
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('JSON');
    expect(stats.compaction).toBe(1);
    expect(agent.historyMessageCount).toBe(4);
    expect(agent.hasSummary).toBe(false);
  });

  it('手动整理成功后重置闲置锚点，下一条消息不会立刻重复整理', async () => {
    const facts = makeFacts(join(dir, 'facts'));
    const selfNotes = new SelfNoteStore({
      dir: join(dir, 'selfnotes'),
      max: 40,
      bootstrapLimit: 20,
      now: () => clock,
    });
    const { provider, stats } = makeProvider(
      '{"facts":[{"text":"他在准备考试","tag":"identity"}],"selfNotes":[],"summary":"聊了考试"}',
    );
    const agent = makeAgent(provider, facts, selfNotes);

    for (let i = 0; i < 6; i += 1) {
      await agent.runTurn(`整理前第${i}轮`.repeat(20), {
        signal: new AbortController().signal,
      });
    }
    clock += IDLE_MS * 2;

    expect((await agent.consolidateNow()).ok).toBe(true);
    expect(stats.compaction).toBe(1);

    await agent.runTurn('紧接着的新消息', { signal: new AbortController().signal });
    expect(stats.compaction).toBe(1);
  });

  it('consolidateNow({signal}) 中断后不写记忆、不更新摘要、不截断历史', async () => {
    const facts = makeFacts(join(dir, 'facts'));
    const selfNotes = new SelfNoteStore({
      dir: join(dir, 'selfnotes'),
      max: 40,
      bootstrapLimit: 20,
      now: () => clock,
    });
    const { provider, compactionStarted } = makeAbortableCompactionProvider(
      '{"facts":[{"text":"不应写入","tag":"misc"}],"selfNotes":["不应写入"],"summary":"不应写入"}',
    );
    const warnings: string[] = [];
    const agent = makeAgent(provider, facts, selfNotes, {}, {
      onWarn: (message) => warnings.push(message),
    });
    await buildHistory(agent);
    const historyBefore = agent.historyMessageCount;
    const controller = new AbortController();

    const pending = agent.consolidateNow({ signal: controller.signal });
    await compactionStarted;
    controller.abort();
    const result = await pending;

    expect(result).toEqual({ ok: false, reason: '整理已中断' });
    expect(agent.historyMessageCount).toBe(historyBefore);
    expect(agent.factsCount).toBe(0);
    expect(agent.selfNoteCount).toBe(0);
    expect(agent.hasSummary).toBe(false);
    expect(warnings).toHaveLength(0);
  }, 1_000);
});
