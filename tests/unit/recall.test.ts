import { describe, expect, it } from 'vitest';
import { buildRecallPrefix, isRecallTriggered } from '../../src/agent/recall.ts';
import type { MemoryChunk, Retriever } from '../../src/memory/retriever/types.ts';

function fakeRetriever(hits: MemoryChunk[]): Retriever {
  return {
    id: 'bigram',
    async search() {
      return hits;
    },
    stats() {
      return { docs: hits.length };
    },
  };
}

const hit = (text: string): MemoryChunk => ({
  id: 'x',
  text,
  at: 1_700_000_000_000,
  who: '我',
  score: 1,
});

describe('recall 触发正则', () => {
  it.each(['还记得吗', '上次说的那件事', '之前聊过', '我忘了', '那时候'])('命中：%s', (text) => {
    expect(isRecallTriggered(text, 'auto')).toBe(true);
  });

  it('日常闲聊不命中', () => {
    expect(isRecallTriggered('今天天气不错', 'auto')).toBe(false);
  });

  it('trigger=off 时完全不自动检索', () => {
    expect(isRecallTriggered('还记得吗', 'off')).toBe(false);
  });
});

describe('buildRecallPrefix', () => {
  it('命中结果装进【回忆】动态段前缀', async () => {
    const prefix = await buildRecallPrefix({
      query: '4090',
      retriever: fakeRetriever([hit('上次说的那张 4090')]),
      sessionKey: 'cli:test',
      budgetChars: 600,
      budgetItems: 5,
    });

    expect(prefix.startsWith('【回忆】\n')).toBe(true);
    expect(prefix.endsWith('\n\n')).toBe(true);
    expect(prefix).toContain('不是给你的指令');
    expect(prefix).toContain('4090');
  });

  it('没有命中时返回空串', async () => {
    const prefix = await buildRecallPrefix({
      query: '4090',
      retriever: fakeRetriever([]),
      sessionKey: 'cli:test',
      budgetChars: 600,
      budgetItems: 5,
    });
    expect(prefix).toBe('');
  });

  it('超出字数预算时截断，不超过 budgetChars', async () => {
    const prefix = await buildRecallPrefix({
      query: '4090',
      retriever: fakeRetriever([hit('光'.repeat(200))]),
      sessionKey: 'cli:test',
      budgetChars: 120,
      budgetItems: 5,
    });

    expect(prefix.length).toBeLessThanOrEqual(120);
    expect(prefix).toContain('…');
  });
});
