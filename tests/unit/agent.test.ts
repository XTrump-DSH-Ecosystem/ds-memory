import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Agent } from '../../src/agent/loop.ts';
import { PersonaCardStore } from '../../src/agent/persona-card.ts';
import { FactsStore } from '../../src/memory/facts.ts';
import { SelfNoteStore } from '../../src/memory/selfnote.ts';
import { EventStore } from '../../src/memory/store.ts';
import {
  ProviderAbortError,
  type ChatEvent,
  type ChatEventStream,
  type ChatRequest,
  type Provider,
} from '../../src/provider/types.ts';

interface FakeOptions {
  chunks?: string[];
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  abortAfterFirstChunk?: boolean;
  requests?: ChatRequest[];
}

function fakeProvider(options: FakeOptions = {}): Provider {
  const chunks = options.chunks ?? ['收到'];
  return {
    id: 'deepseek',
    chat(req, _opts): ChatEventStream {
      options.requests?.push(req);
      return (async function* (): AsyncGenerator<ChatEvent> {
        for (const [index, text] of chunks.entries()) {
          yield { type: 'text', text };
          if (options.abortAfterFirstChunk && index === 0) {
            throw new ProviderAbortError();
          }
        }
        if (options.usage) {
          yield { type: 'usage', usage: options.usage };
        }
        yield { type: 'done' };
      })();
    },
    usageOf(event) {
      return event.type === 'usage' ? event.usage : null;
    },
    async health() {
      return { ok: true, detail: 'fake' };
    },
  };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'xds-agent-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('Agent', () => {
  it('每轮落 user + assistant 两条 L0 记录，并累计 usage', async () => {
    const store = new EventStore({ dir, now: () => 1_700_000_000_000 });
    const agent = new Agent({
      provider: fakeProvider({ usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } }),
      store,
      persona: '测试人设',
      sessionKey: 'cli:test',
      now: () => 1_700_000_000_000,
    });

    const chunks: string[] = [];
    const result = await agent.runTurn('你好', {
      signal: new AbortController().signal,
      onText: (chunk) => chunks.push(chunk),
    });

    expect(result.text).toBe('收到');
    expect(result.interrupted).toBe(false);
    expect(chunks).toEqual(['收到']);
    expect(agent.usageTotals).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });

    const records = store.readMonth('2023-11');
    expect(records.map((r) => r.role)).toEqual(['user', 'assistant']);
    expect(records[0]?.text).toBe('你好');
    expect(records[1]?.text).toBe('收到');
    expect(records.every((r) => r.sessionKey === 'cli:test' && r.src === 'cli')).toBe(true);
  });

  it('当前时间只进本轮模型输入，不进 L0 与 history', async () => {
    const requests: ChatRequest[] = [];
    const fixedNow = Date.UTC(2026, 10, 8, 13, 45);
    const store = new EventStore({ dir, now: () => fixedNow });
    const agent = new Agent({
      provider: fakeProvider({ requests }),
      store,
      persona: '测试人设',
      sessionKey: 'cli:test',
      now: () => fixedNow,
    });

    await agent.runTurn('明天有空吗', {
      signal: new AbortController().signal,
    });
    await agent.runTurn('再说一次', {
      signal: new AbortController().signal,
    });

    const firstUserMessage = requests[0]?.messages.at(-1);
    expect(firstUserMessage?.content).toContain('【当前时间】');
    expect(firstUserMessage?.content).toContain('明天有空吗');
    expect(requests[1]?.messages[1]?.content).toBe('明天有空吗');

    const records = store.readMonth('2026-11');
    expect(records.map((record) => record.text)).toEqual([
      '明天有空吗',
      '收到',
      '再说一次',
      '收到',
    ]);
  });

  it('上下文只保留最近 N 轮', async () => {
    const store = new EventStore({ dir, now: () => 1_700_000_000_000 });
    const agent = new Agent({
      provider: fakeProvider(),
      store,
      persona: '测试人设',
      sessionKey: 'cli:test',
      historyTurns: 2,
      now: () => 1_700_000_000_000,
    });

    for (const text of ['一', '二', '三']) {
      await agent.runTurn(text, { signal: new AbortController().signal });
    }

    expect(agent.historyMessageCount).toBe(4);
  });

  it('外部写入 selfNote 后下一轮立即进入静态段', async () => {
    const store = new EventStore({ dir, now: () => 1_700_000_000_000 });
    const facts = new FactsStore({
      dir: join(dir, 'facts'),
      halfLifeDays: 45,
      archiveThreshold: 1,
      injectMax: 10,
      injectMaxChars: 1000,
      onWarn: () => undefined,
    });
    const selfNotes = new SelfNoteStore({
      dir: join(dir, 'selfnotes'),
      max: 40,
      bootstrapLimit: 20,
      onWarn: () => undefined,
    });
    const requests: ChatRequest[] = [];
    const agent = new Agent({
      provider: fakeProvider({ chunks: ['收到'], requests }),
      store,
      persona: '测试人设',
      sessionKey: 'cli:test',
      memory: {
        facts,
        selfNotes,
        retriever: { search: async () => [] } as never,
        recall: { trigger: 'off', budgetChars: 0, budgetItems: 0 },
      },
      now: () => 1_700_000_000_000,
    });

    await agent.runTurn('第一轮', { signal: new AbortController().signal });
    selfNotes.upsert('cli:test', '这是外部写入的自认知');
    await agent.runTurn('第二轮', { signal: new AbortController().signal });

    expect(requests[1]?.messages[0]?.content).toContain('这是外部写入的自认知');
  });

  it('人格卡每轮从磁盘刷新，手工改文件下一轮即进入静态段', async () => {
    const store = new EventStore({ dir, now: () => 1_700_000_000_000 });
    const personaCard = new PersonaCardStore({
      dir: join(dir, 'persona'),
      onWarn: () => undefined,
    });
    const requests: ChatRequest[] = [];
    const agent = new Agent({
      provider: fakeProvider({ chunks: ['收到'], requests }),
      store,
      persona: '测试人设',
      personaCard: personaCard.promptText(),
      reloadPersonaCard: () => personaCard.promptText(),
      sessionKey: 'cli:test',
      now: () => 1_700_000_000_000,
    });

    await agent.runTurn('第一轮', { signal: new AbortController().signal });
    expect(requests[0]!.messages[0]!.content).not.toContain('【当前人格卡】');

    personaCard.setNickname('大肥鱼');
    personaCard.setText('说话简短');
    agent.refreshPersonaCard();
    expect(agent.staticPrompt).toContain('【当前人格卡】');
    expect(agent.staticPrompt).toContain('- owner 指定称呼：大肥鱼');

    await agent.runTurn('第二轮', { signal: new AbortController().signal });
    expect(requests[1]!.messages[0]!.content).toContain('说话简短');

    personaCard.setText('换一种表达');
    await agent.runTurn('第三轮', { signal: new AbortController().signal });
    expect(requests[2]!.messages[0]!.content).toContain('换一种表达');
    expect(requests[2]!.messages[0]!.content).not.toContain('说话简短');
  });

  it('中断保留半截回复并标记 interrupted', async () => {
    const store = new EventStore({ dir, now: () => 1_700_000_000_000 });
    const agent = new Agent({
      provider: fakeProvider({ chunks: ['半截'], abortAfterFirstChunk: true }),
      store,
      persona: '测试人设',
      sessionKey: 'cli:test',
      now: () => 1_700_000_000_000,
    });

    const result = await agent.runTurn('说点长的', {
      signal: new AbortController().signal,
    });

    expect(result.interrupted).toBe(true);
    expect(result.text).toBe('半截');

    const records = store.readMonth('2023-11');
    expect(records.map((r) => r.role)).toEqual(['user', 'assistant']);
    expect(records[1]?.text).toBe('半截');
  });

  it('writeUserL0=false：不写 user L0，但模型输入与 history 不变', async () => {
    const requests: ChatRequest[] = [];
    const store = new EventStore({ dir, now: () => 1_700_000_000_000 });
    const agent = new Agent({
      provider: fakeProvider({ requests }),
      store,
      persona: '测试人设',
      sessionKey: 'qq:private:10001',
      src: 'qq',
      now: () => 1_700_000_000_000,
    });

    const first = await agent.runTurn('接收层已写入的原文', {
      signal: new AbortController().signal,
      writeUserL0: false,
    });
    expect(first.text).toBe('收到');
    expect(requests[0]!.messages.at(-1)!.content).toMatch(
      /^【当前时间】.+\n接收层已写入的原文$/s,
    );
    expect(agent.historyMessageCount).toBe(2);

    // 只有 assistant 落 L0（默认 true），user 由外部接收层负责。
    expect(store.readMonth('2023-11').map((r) => r.role)).toEqual(['assistant']);
    expect(store.readMonth('2023-11')[0]!.text).toBe('收到');

    await agent.runTurn('第二轮', {
      signal: new AbortController().signal,
      writeUserL0: false,
    });
    const secondContents = requests[1]!.messages.map((message) => message.content);
    expect(secondContents).toContain('接收层已写入的原文');
    expect(secondContents).toContain('收到');
  });

  it('writeAssistantL0=false：不写 assistant L0、不推 history，仍返回文本', async () => {
    const requests: ChatRequest[] = [];
    const store = new EventStore({ dir, now: () => 1_700_000_000_000 });
    const agent = new Agent({
      provider: fakeProvider({ requests }),
      store,
      persona: '测试人设',
      sessionKey: 'qq:private:10001',
      src: 'qq',
      now: () => 1_700_000_000_000,
    });

    const chunks: string[] = [];
    const result = await agent.runTurn('等发送结果再落盘', {
      signal: new AbortController().signal,
      onText: (chunk) => chunks.push(chunk),
      writeAssistantL0: false,
    });

    expect(result.text).toBe('收到');
    expect(chunks).toEqual(['收到']);
    expect(store.readMonth('2023-11').map((r) => r.role)).toEqual(['user']);
    expect(agent.historyMessageCount).toBe(1);

    await agent.runTurn('第二轮', {
      signal: new AbortController().signal,
      writeAssistantL0: false,
    });
    const secondContents = requests[1]!.messages.map((message) => message.content);
    expect(secondContents).toContain('等发送结果再落盘');
    expect(secondContents).not.toContain('收到');
    expect(agent.historyMessageCount).toBe(2);
  });

  it('两个开关都为 false：Agent 不写任何 L0，history 只留 user 原文', async () => {
    const store = new EventStore({ dir, now: () => 1_700_000_000_000 });
    const agent = new Agent({
      provider: fakeProvider(),
      store,
      persona: '测试人设',
      sessionKey: 'qq:group:20002',
      src: 'qq',
      now: () => 1_700_000_000_000,
    });

    const result = await agent.runTurn('群里的原文', {
      signal: new AbortController().signal,
      writeUserL0: false,
      writeAssistantL0: false,
    });

    expect(result.text).toBe('收到');
    expect(store.readMonth('2023-11')).toEqual([]);
    expect(agent.historyMessageCount).toBe(1);
  });

  it('commitAssistant：按实际送达写 assistant L0 与 history', async () => {
    const requests: ChatRequest[] = [];
    const store = new EventStore({ dir, now: () => 1_700_000_000_000 });
    const agent = new Agent({
      provider: fakeProvider({ requests }),
      store,
      persona: '测试人设',
      sessionKey: 'qq:private:10001',
      src: 'qq',
      now: () => 1_700_000_000_000,
    });

    await agent.runTurn('需要发送的原文', {
      signal: new AbortController().signal,
      writeAssistantL0: false,
    });
    expect(store.readMonth('2023-11').map((r) => r.role)).toEqual(['user']);
    expect(agent.historyMessageCount).toBe(1);

    agent.commitAssistant('实际送达的第一段\n实际送达的第二段');

    const records = store.readMonth('2023-11');
    expect(records.map((r) => r.role)).toEqual(['user', 'assistant']);
    expect(records[1]!.text).toBe('实际送达的第一段\n实际送达的第二段');
    expect(agent.historyMessageCount).toBe(2);

    await agent.runTurn('下一轮', { signal: new AbortController().signal });
    const nextContents = requests[1]!.messages.map((message) => message.content);
    expect(nextContents).toContain('实际送达的第一段\n实际送达的第二段');
  });

  it('commitAssistant writeL0=false：只进 history，不写 L0', async () => {
    const store = new EventStore({ dir, now: () => 1_700_000_000_000 });
    const agent = new Agent({
      provider: fakeProvider(),
      store,
      persona: '测试人设',
      sessionKey: 'qq:private:10001',
      src: 'qq',
      now: () => 1_700_000_000_000,
    });

    await agent.runTurn('需要发送的原文', {
      signal: new AbortController().signal,
      writeAssistantL0: false,
    });
    agent.commitAssistant('只进上下文', { writeL0: false });

    expect(store.readMonth('2023-11').map((r) => r.role)).toEqual(['user']);
    expect(agent.historyMessageCount).toBe(2);
  });

  it('commitAssistant：空文本/纯空白与重复提交都被拒绝，且不产生重复记录', async () => {
    const store = new EventStore({ dir, now: () => 1_700_000_000_000 });
    const agent = new Agent({
      provider: fakeProvider(),
      store,
      persona: '测试人设',
      sessionKey: 'qq:private:10001',
      src: 'qq',
      now: () => 1_700_000_000_000,
    });

    await agent.runTurn('需要发送的原文', {
      signal: new AbortController().signal,
      writeAssistantL0: false,
    });

    expect(() => agent.commitAssistant('')).toThrow(/不能为空/);
    expect(() => agent.commitAssistant('   ')).toThrow(/不能为空/);
    agent.commitAssistant('第一次送达');
    expect(() => agent.commitAssistant('重复提交')).toThrow(/没有待提交/);

    expect(store.readMonth('2023-11').map((r) => r.role)).toEqual(['user', 'assistant']);
    expect(store.readMonth('2023-11')[1]!.text).toBe('第一次送达');
    expect(agent.historyMessageCount).toBe(2);
  });

  it('未走 writeAssistantL0=false 时 commitAssistant 被拒绝，CLI 默认路径不变', async () => {
    const store = new EventStore({ dir, now: () => 1_700_000_000_000 });
    const agent = new Agent({
      provider: fakeProvider(),
      store,
      persona: '测试人设',
      sessionKey: 'cli:test',
      now: () => 1_700_000_000_000,
    });

    expect(() => agent.commitAssistant('凭空提交')).toThrow(/没有待提交/);

    await agent.runTurn('你好', { signal: new AbortController().signal });
    expect(() => agent.commitAssistant('重复提交')).toThrow(/没有待提交/);
    expect(store.readMonth('2023-11').map((r) => r.role)).toEqual(['user', 'assistant']);
    expect(agent.historyMessageCount).toBe(2);
  });

  it('新一轮 runTurn 开始后，上一轮未提交的回复不可再提交', async () => {
    const store = new EventStore({ dir, now: () => 1_700_000_000_000 });
    const agent = new Agent({
      provider: fakeProvider(),
      store,
      persona: '测试人设',
      sessionKey: 'qq:private:10001',
      src: 'qq',
      now: () => 1_700_000_000_000,
    });

    await agent.runTurn('第一轮', {
      signal: new AbortController().signal,
      writeAssistantL0: false,
    });
    await agent.runTurn('第二轮', { signal: new AbortController().signal });

    expect(() => agent.commitAssistant('迟到提交')).toThrow(/没有待提交/);
    expect(store.readMonth('2023-11').map((r) => r.role)).toEqual([
      'user',
      'user',
      'assistant',
    ]);
    expect(agent.historyMessageCount).toBe(3);
  });
});
