import { describe, expect, it } from 'vitest';
import {
  buildReplyPlan,
  QQ_REPLY_MAX_CHARS,
} from '../../src/qq/reply.ts';

describe('buildReplyPlan', () => {
  it('空文本与纯空白都得到空计划', () => {
    expect(buildReplyPlan('', { maxPerTurn: 3 })).toEqual({ messages: [] });
    expect(buildReplyPlan('  \n\t  ', { maxPerTurn: 3 })).toEqual({ messages: [] });
  });

  it('maxPerTurn=0 保留静音语义', () => {
    expect(buildReplyPlan('不应发送。', { maxPerTurn: 0 })).toEqual({ messages: [] });
  });

  it('四句普通回复完整一条，不按句拆条', () => {
    const text = '第一句。第二句！第三句？最后一句';
    expect(buildReplyPlan(text, { maxPerTurn: 3 }).messages).toEqual([text]);
  });

  it('十句普通回复仍完整一条', () => {
    const text = Array.from({ length: 10 }, (_, index) => `第${index + 1}句。`).join('');
    const plan = buildReplyPlan(text, { maxPerTurn: 1 });

    expect(plan.messages).toEqual([text]);
    expect(plan.messages).toHaveLength(1);
  });

  it('正数 maxPerTurn 不再截断，也不记截断日志', () => {
    const logs: string[] = [];
    const text = '一。二。三。四。';
    const plan = buildReplyPlan(text, {
      maxPerTurn: 1,
      onInfo: (message) => logs.push(message),
    });

    expect(plan.messages).toEqual([text]);
    expect(logs).toEqual([]);
  });

  it('未超过 3000 字时保留原文与句末标点', () => {
    expect(buildReplyPlan('今天先这样。', { maxPerTurn: 3 }).messages).toEqual([
      '今天先这样。',
    ]);
    expect(buildReplyPlan('没有句末标点', { maxPerTurn: 3 }).messages).toEqual([
      '没有句末标点',
    ]);
  });

  it('恰好 3000 字仍为一条', () => {
    const text = '甲'.repeat(QQ_REPLY_MAX_CHARS);
    expect(buildReplyPlan(text, { maxPerTurn: 3 }).messages).toEqual([text]);
  });

  it('超过 3000 字按换行边界分块，所有片段拼接等于原文', () => {
    const paragraph = '甲'.repeat(1500);
    const text = `${paragraph}\n${paragraph}\n${paragraph}`;
    const plan = buildReplyPlan(text, { maxPerTurn: 3 });

    expect(plan.messages.length).toBeGreaterThan(1);
    expect(plan.messages.join('')).toBe(text);
    expect(plan.messages[0]!.endsWith('\n')).toBe(true);
    for (const message of plan.messages) {
      expect(Array.from(message).length).toBeLessThanOrEqual(QQ_REPLY_MAX_CHARS);
    }
  });

  it('没有换行时优先在句末标点后切分', () => {
    const text = `${'甲'.repeat(2900)}。${'乙'.repeat(200)}`;
    const plan = buildReplyPlan(text, { maxPerTurn: 3 });

    expect(plan.messages.length).toBeGreaterThan(1);
    expect(plan.messages[0]!.endsWith('。')).toBe(true);
    expect(plan.messages.join('')).toBe(text);
  });

  it('分块日志只含块数，不含正文', () => {
    const logs: string[] = [];
    const text = `${'甲'.repeat(2900)}。${'乙'.repeat(200)}`;
    const plan = buildReplyPlan(text, {
      maxPerTurn: 3,
      onInfo: (message) => logs.push(message),
    });

    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain(`${plan.messages.length} 条`);
    expect(logs[0]).toContain('3000');
    expect(logs[0]).not.toContain('甲');
    expect(logs[0]).not.toContain('乙');
  });

  it('只在 emoji 边界分块，不切开代理对', () => {
    const text = `${'a'.repeat(QQ_REPLY_MAX_CHARS - 1)}😀z`;
    const plan = buildReplyPlan(text, { maxPerTurn: 3 });

    expect(plan.messages).toHaveLength(2);
    expect(plan.messages[0]!.endsWith('😀')).toBe(true);
    expect(plan.messages[1]).toBe('z');
    expect(plan.messages.join('')).toBe(text);
  });

  it('极端长文本无任何边界时硬切，仍不丢原文', () => {
    const text = 'x'.repeat(QQ_REPLY_MAX_CHARS * 2 + 17);
    const plan = buildReplyPlan(text, { maxPerTurn: 3 });

    expect(plan.messages).toHaveLength(3);
    expect(plan.messages.map((message) => Array.from(message).length)).toEqual([
      QQ_REPLY_MAX_CHARS,
      QQ_REPLY_MAX_CHARS,
      17,
    ]);
    expect(plan.messages.join('')).toBe(text);
  });
});
