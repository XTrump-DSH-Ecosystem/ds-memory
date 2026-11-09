import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BATCH_LIMITS,
  ITEM_TRUNCATION_MARKER,
  batchLimitsFromConfig,
  formatOmissionHint,
  planBatch,
} from '../../src/qq/batch.ts';
import type { InboxItem } from '../../src/qq/types.ts';

const BASE = 1_700_000_000_000;

function item(
  eventId: string,
  receivedAt: number,
  overrides: Partial<InboxItem> = {},
): InboxItem {
  return {
    eventId,
    sessionKey: 'private:1',
    kind: 'private',
    speaker: null,
    text: `正文 ${eventId}`,
    quote: null,
    isAtBot: false,
    receivedAt,
    ...overrides,
  };
}

function charCount(text: string): number {
  return Array.from(text).length;
}

describe('planBatch', () => {
  it('窗口内 3 条合并为一次投递', () => {
    const items = [
      item('m1', BASE, { text: '第一条' }),
      item('m2', BASE + 500, { text: '第二条' }),
      item('m3', BASE + 1900, { text: '第三条' }),
    ];

    const plan = planBatch(items);

    expect(plan.included.map((entry) => entry.item.eventId)).toEqual(['m1', 'm2', 'm3']);
    expect(plan.omitted).toEqual([]);
    expect(plan.modelText.split('\n')).toEqual(['第一条', '第二条', '第三条']);
    expect(plan.totalChars).toBe(charCount(plan.modelText));
    expect(plan.totalChars).toBeLessThanOrEqual(DEFAULT_BATCH_LIMITS.maxChars);
  });

  it('窗口外消息进入下一批（新回合），原文不丢', () => {
    const items = [
      item('m1', BASE, { text: '第一批原文' }),
      item('m2', BASE + 2001, { text: '第二批原文' }),
    ];

    const first = planBatch(items);

    expect(first.included.map((entry) => entry.item.eventId)).toEqual(['m1']);
    expect(first.omitted.map((entry) => entry.eventId)).toEqual(['m2']);
    expect(first.modelText).toContain('已省略 1 条');

    const second = planBatch(first.omitted);
    expect(second.included.map((entry) => entry.item.eventId)).toEqual(['m2']);
    expect(second.included[0]!.item.text).toBe('第二批原文');
    expect(second.omitted).toEqual([]);
  });

  it('窗口自首条起算，而不是自上一条起算', () => {
    const items = [
      item('m1', BASE, { text: '一' }),
      item('m2', BASE + 1500, { text: '二' }),
      item('m3', BASE + 2600, { text: '三' }),
    ];

    const plan = planBatch(items);

    // 第三条距首条 2600ms，虽然距第二条只有 1100ms，也应进入下一批。
    expect(plan.included.map((entry) => entry.item.eventId)).toEqual(['m1', 'm2']);
    expect(plan.omitted.map((entry) => entry.eventId)).toEqual(['m3']);
  });

  it('窗口边界：恰好 2000ms 计入，2001ms 进入下一批', () => {
    const plan = planBatch([
      item('m1', BASE),
      item('m2', BASE + 2000),
      item('m3', BASE + 2001),
    ]);

    expect(plan.included.map((entry) => entry.item.eventId)).toEqual(['m1', 'm2']);
    expect(plan.omitted.map((entry) => entry.eventId)).toEqual(['m3']);
  });

  it('最多 12 条：第 13 条进入下一批', () => {
    const items = Array.from({ length: 13 }, (_, index) =>
      item(`m${index + 1}`, BASE + index * 10),
    );

    const plan = planBatch(items);

    expect(plan.included).toHaveLength(12);
    expect(plan.omitted.map((entry) => entry.eventId)).toEqual(['m13']);
    expect(plan.modelText).toContain('已省略 1 条');

    const next = planBatch(plan.omitted);
    expect(next.included.map((entry) => entry.item.eventId)).toEqual(['m13']);
  });

  it('单条正文最多 300 字：模型输入截断，items 保留完整原文', () => {
    const original = '字'.repeat(400);
    const plan = planBatch([item('m1', BASE, { text: original })]);

    const rendered = plan.included[0]!;
    expect(rendered.item.text).toBe(original);
    expect(rendered.truncated).toBe(true);
    expect(plan.truncatedCount).toBe(1);
    expect(charCount(rendered.modelText)).toBe(300);
    expect(rendered.modelText.endsWith(ITEM_TRUNCATION_MARKER)).toBe(true);
    expect(plan.modelText).not.toContain(original);
  });

  it('群说话人标签与引用前缀拼进 modelText，但 items[].text 保持原文', () => {
    const original = '@机器人 看一下';
    const quote = { fromName: '李四', text: '被引用的原文' };
    const plan = planBatch([
      item('g1', BASE, {
        kind: 'group',
        sessionKey: 'group:9',
        speaker: '张三',
        quote,
        isAtBot: true,
        text: original,
      }),
    ]);

    expect(plan.modelText).toBe('[群友] 张三：[引用 李四：被引用的原文] @机器人 看一下');
    expect(plan.included[0]!.item.text).toBe(original);
    expect(plan.totalChars).toBe(charCount(plan.modelText));
  });

  it('总字符 4000 上限：标签/引用前缀/省略提示均计入，溢出进下一批且原文不丢', () => {
    const items = Array.from({ length: 10 }, (_, index) =>
      item(`g${index + 1}`, BASE + index * 10, {
        kind: 'group',
        sessionKey: 'group:9',
        speaker: '张三',
        quote: { fromName: '李四', text: '引'.repeat(100) },
        isAtBot: true,
        text: '正'.repeat(300),
      }),
    );

    const plan = planBatch(items);

    expect(plan.included.length).toBeGreaterThan(0);
    expect(plan.included.length).toBeLessThan(items.length);
    expect(plan.totalChars).toBeLessThanOrEqual(4000);
    expect(plan.totalChars).toBe(charCount(plan.modelText));
    expect(plan.modelText).toContain(`已省略 ${plan.omitted.length} 条`);

    const includedIds = plan.included.map((entry) => entry.item.eventId);
    const omittedIds = plan.omitted.map((entry) => entry.eventId);
    expect([...includedIds, ...omittedIds]).toEqual(items.map((entry) => entry.eventId));

    for (const omitted of plan.omitted) {
      const original = items.find((entry) => entry.eventId === omitted.eventId)!;
      expect(omitted.text).toBe(original.text);
      expect(omitted.quote).toEqual(original.quote);
    }

    const next = planBatch(plan.omitted);
    expect(next.included.length).toBeGreaterThan(0);
    expect(next.included[0]!.item.text).toBe('正'.repeat(300));
  });

  it('空输入返回空计划', () => {
    expect(planBatch([])).toEqual({
      included: [],
      omitted: [],
      modelText: '',
      totalChars: 0,
      truncatedCount: 0,
    });
  });

  it('退化 maxChars 仍至少纳入 1 条，且按 omitted 重排可持续前进', () => {
    const texts: Record<string, string> = {
      m1: '第一条完整原文内容需要截断',
      m2: '第二条完整原文内容需要截断',
      m3: '第三条完整原文内容需要截断',
    };
    const items = Object.entries(texts).map(([eventId, text], index) =>
      item(eventId, BASE + index * 10, { text }),
    );
    const limits = { ...DEFAULT_BATCH_LIMITS, maxChars: 10 };

    let remaining = items;
    const includedIds: string[] = [];

    for (let round = 0; round < items.length + 1 && remaining.length > 0; round += 1) {
      const plan = planBatch(remaining, limits);

      expect(plan.included.length).toBeGreaterThanOrEqual(1);
      expect(plan.totalChars).toBeLessThanOrEqual(limits.maxChars);
      expect(plan.omitted.length).toBeLessThan(remaining.length);

      for (const entry of plan.included) {
        expect(entry.item.text).toBe(texts[entry.item.eventId]);
        includedIds.push(entry.item.eventId);
      }
      remaining = plan.omitted;
    }

    expect(remaining).toEqual([]);
    expect(includedIds).toEqual(['m1', 'm2', 'm3']);
  });

  it('included 为空时 modelText 只有省略提示，没有前导换行', () => {
    const plan = planBatch([item('m1', BASE, { text: '窗口外原文' })], {
      ...DEFAULT_BATCH_LIMITS,
      windowMs: -1,
    });

    expect(plan.included).toEqual([]);
    expect(plan.omitted.map((entry) => entry.eventId)).toEqual(['m1']);
    expect(plan.modelText).toBe(formatOmissionHint(1));
    expect(plan.modelText.startsWith('\n')).toBe(false);
    expect(plan.totalChars).toBe(charCount(formatOmissionHint(1)));
  });

  it('batchLimitsFromConfig 映射 qq 配置字段', () => {
    expect(
      batchLimitsFromConfig({
        batchWindowMs: 1234,
        batchMaxMessages: 5,
        batchMessageMaxChars: 200,
        batchMaxChars: 3000,
      }),
    ).toEqual({
      windowMs: 1234,
      maxMessages: 5,
      messageMaxChars: 200,
      maxChars: 3000,
    });
  });
});
