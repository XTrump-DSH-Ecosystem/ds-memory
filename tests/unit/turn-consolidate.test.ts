import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Agent } from '../../src/agent/loop.ts';
import { PersonaCardStore } from '../../src/agent/persona-card.ts';
import { FactsStore } from '../../src/memory/facts.ts';
import { BigramRetriever } from '../../src/memory/retriever/bigram.ts';
import { SelfNoteStore } from '../../src/memory/selfnote.ts';
import { EventStore } from '../../src/memory/store.ts';
import { AgentRegistry } from '../../src/qq/agent-registry.ts';
import { runQqMemoryCommand } from '../../src/qq/memory-commands.ts';
import { runQqTurn } from '../../src/qq/turn.ts';
import type {
  QqSender,
  QqTarget,
  ReceiptStore,
  SendResult,
  WakePacket,
} from '../../src/qq/types.ts';
import {
  usageOfEvent,
  type ChatEvent,
  type ChatEventStream,
  type Provider,
} from '../../src/provider/types.ts';

const NOW = 1_700_000_000_000;
const SESSION = 'private:10001';
const TARGET: QqTarget = { kind: 'private', id: '10001' };

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'xds-consolidate-command-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function providerHarness(): {
  provider: Provider;
  stats: { normal: number; compaction: number };
} {
  const stats = { normal: 0, compaction: 0 };
  const provider: Provider = {
    id: 'deepseek',
    chat(req): ChatEventStream {
      const compaction = (req.messages[0]?.content ?? '').includes('记忆整理');
      if (compaction) stats.compaction += 1;
      else stats.normal += 1;
      const text = compaction
        ? '{"facts":[{"text":"他喜欢喝咖啡","tag":"preference"}],"selfNotes":[],"summary":"聊了咖啡"}'
        : '正常回复';
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

function makeReceipts(): ReceiptStore {
  return {
    reserve() {
      throw new Error('本测试不应调用 reserve');
    },
    markProcessing() {
      return true;
    },
    markStoredOnly() {
      return true;
    },
    markDone() {
      return true;
    },
    markFailed() {
      return true;
    },
    bootstrapFromL0() {
      return { recovered: [], aborted: [] };
    },
    prune() {},
  };
}

function allSent(count: number): SendResult {
  return {
    outcome: 'all_sent',
    sentIndexes: Array.from({ length: count }, (_, index) => index),
    failedIndexes: [],
    retryable: false,
    retryAfterMs: null,
    reason: null,
  };
}

function wakeOf(text: string): WakePacket {
  return {
    sessionKey: SESSION,
    items: [
      {
        eventId: 'e-consolidate',
        speaker: null,
        senderRole: 'owner',
        origin: 'live',
        quote: null,
        text,
        at: NOW,
      },
    ],
    omittedEventIds: [],
    modelText: text,
    totalChars: text.length,
    truncatedCount: 0,
  };
}

describe('QQ !整理 真实接线', () => {
  it('命令使用当前 session Agent 整理，发送回执但不写 assistant L0/history', async () => {
    const store = new EventStore({ dir: join(dir, 'events'), now: () => NOW });
    const facts = new FactsStore({
      dir: join(dir, 'facts'),
      halfLifeDays: 45,
      archiveThreshold: 1,
      injectMax: 30,
      injectMaxChars: 900,
      now: () => NOW,
      onWarn: () => {},
    });
    const selfNotes = new SelfNoteStore({
      dir: join(dir, 'selfnotes'),
      max: 40,
      bootstrapLimit: 20,
      now: () => NOW,
    });
    const retriever = new BigramRetriever({ store, now: () => NOW });
    const personaCard = new PersonaCardStore({
      dir: join(dir, 'persona'),
      onWarn: () => {},
    });
    const { provider, stats } = providerHarness();
    const agent = new Agent({
      provider,
      store,
      persona: '测试人设',
      sessionKey: SESSION,
      src: 'qq',
      now: () => NOW,
      memory: {
        facts,
        selfNotes,
        retriever,
        recall: { trigger: 'auto', budgetChars: 600, budgetItems: 5 },
      },
      compaction: {
        enabled: true,
        idleMs: 100_000,
        thresholdTokens: 1_000_000,
        minTurns: 6,
        sessionStateDir: join(dir, 'sessions'),
      },
      onWarn: () => {},
      onInfo: () => {},
    });
    const registry = new AgentRegistry({ createAgent: () => agent });

    await agent.runTurn('我喜欢喝咖啡', {
      signal: new AbortController().signal,
      writeUserL0: false,
      writeAssistantL0: false,
    });
    expect(agent.historyMessageCount).toBe(1);

    let sent: string[] = [];
    const sender: QqSender = {
      async send(_target, messages) {
        sent = [...messages];
        return allSent(messages.length);
      },
    };

    const result = await runQqTurn({
      registry,
      sessionKey: SESSION,
      wake: wakeOf('!整理'),
      sender,
      receipts: makeReceipts(),
      target: TARGET,
      maxPerTurn: 3,
      signal: new AbortController().signal,
      commands: (text, currentAgent) =>
        runQqMemoryCommand(text, {
          sessionKey: SESSION,
          facts,
          selfNotes,
          personaCard,
          retriever,
          recallBudgetItems: 5,
          consolidate: () => currentAgent.consolidateNow(),
        }),
    });

    expect(stats.normal).toBe(1); // 仅最初那一轮普通对话
    expect(stats.compaction).toBe(1);
    expect(sent).toEqual(['整理完成：事实 1 条，自认知 0 条，摘要已更新']);
    expect(result.deliveredText).toBe(sent[0]);
    expect(facts.count(SESSION)).toBe(1);
    expect(agent.hasSummary).toBe(true);
    expect(agent.historyMessageCount).toBe(1); // 命令与命令回复都不进模型历史
    expect(store.readMonth('2023-11').filter((record) => record.role === 'assistant')).toEqual([]);
  });
});
