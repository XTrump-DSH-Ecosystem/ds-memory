import { describe, expect, it } from 'vitest';
import { buildWakeBatch, buildWakePacket, shouldWake } from '../../src/qq/wake.ts';
import type { InboxItem } from '../../src/qq/types.ts';

const BASE = 1_700_000_000_000;

function item(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    eventId: 'e1',
    sessionKey: 'private:1',
    kind: 'private',
    speaker: null,
    text: '原文',
    quote: null,
    isAtBot: false,
    receivedAt: BASE,
    ...overrides,
  };
}

function charCount(text: string): number {
  return Array.from(text).length;
}

describe('shouldWake', () => {
  it('私聊总是唤醒，群 mention 仅 isAtBot=true 唤醒', () => {
    expect(shouldWake(item())).toBe(true);
    expect(shouldWake(item({ kind: 'group', sessionKey: 'group:9', isAtBot: false }))).toBe(false);
    expect(shouldWake(item({ kind: 'group', sessionKey: 'group:9', isAtBot: true }))).toBe(true);
    expect(
      shouldWake(item({ kind: 'group', sessionKey: 'group:9', isAtBot: false }), 'all'),
    ).toBe(true);
  });
});

describe('buildWakeBatch', () => {
  it('私聊即使 isAtBot=false 也生成唤醒包', () => {
    const result = buildWakeBatch([item({ text: '私聊原文' })]);

    expect(result.storedOnly).toEqual([]);
    expect(result.packet).not.toBeNull();
    expect(result.packet?.items[0]?.text).toBe('私聊原文');
  });

  it('群 mention：isAtBot=true 唤醒，items[].text 保持完整原文', () => {
    const original = '@机器人 请回答原始问题';
    const result = buildWakeBatch([
      item({
        eventId: 'g1',
        sessionKey: 'group:9',
        kind: 'group',
        speaker: '张三',
        isAtBot: true,
        text: original,
      }),
    ]);

    expect(result.packet).not.toBeNull();
    expect(result.storedOnly).toEqual([]);
    expect(result.packet?.items).toHaveLength(1);
    expect(result.packet?.items[0]).toEqual({
      eventId: 'g1',
      speaker: '张三',
      quote: null,
      text: original,
      at: BASE,
    });
    expect(result.packet?.modelText).toContain('张三：');
  });

  it('群 mention：isAtBot=false 只保存，不生成模型唤醒包', () => {
    const result = buildWakeBatch([
      item({
        eventId: 'g2',
        sessionKey: 'group:9',
        kind: 'group',
        speaker: '张三',
        isAtBot: false,
      }),
    ]);

    expect(result.packet).toBeNull();
    expect(result.storedOnly.map((entry) => entry.eventId)).toEqual(['g2']);
    expect(buildWakePacket(result.storedOnly)).toBeNull();
  });

  it('groupWake=all 时未 @ 的群消息也唤醒', () => {
    const result = buildWakeBatch(
      [
        item({
          eventId: 'g3',
          sessionKey: 'group:9',
          kind: 'group',
          speaker: '张三',
          isAtBot: false,
        }),
      ],
      { groupWake: 'all' },
    );

    expect(result.packet).not.toBeNull();
    expect(result.storedOnly).toEqual([]);
  });

  it('混合批：未 @ 消息只保存且不进 omittedEventIds，@ 消息进包', () => {
    const stored = item({
      eventId: 'g1',
      sessionKey: 'group:9',
      kind: 'group',
      speaker: '张三',
      isAtBot: false,
      text: '普通群聊不应进模型',
      receivedAt: BASE,
    });
    const woken = item({
      eventId: 'g2',
      sessionKey: 'group:9',
      kind: 'group',
      speaker: '李四',
      isAtBot: true,
      text: '@机器人 帮我看下',
      receivedAt: BASE + 1900,
    });

    const result = buildWakeBatch([stored, woken]);

    expect(result.storedOnly.map((entry) => entry.eventId)).toEqual(['g1']);
    expect(result.packet?.items.map((entry) => entry.eventId)).toEqual(['g2']);
    expect(result.packet?.omittedEventIds).toEqual([]);
    expect(result.packet?.modelText).toContain('李四：@机器人 帮我看下');
    expect(result.packet?.modelText).not.toContain('普通群聊不应进模型');
  });

  it('所有唤醒条目都在窗口外时 packet=null，omitted 按原序保留全部唤醒条目', () => {
    const stored = item({
      eventId: 'g1',
      sessionKey: 'group:9',
      kind: 'group',
      speaker: '张三',
      isAtBot: false,
      text: '普通群聊只保存',
      receivedAt: BASE,
    });
    const outside1 = item({
      eventId: 'g2',
      sessionKey: 'group:9',
      kind: 'group',
      speaker: '李四',
      isAtBot: true,
      text: '@机器人 第一条窗口外原文',
      receivedAt: BASE + 2001,
    });
    const outside2 = item({
      eventId: 'g3',
      sessionKey: 'group:9',
      kind: 'group',
      speaker: '王五',
      isAtBot: true,
      text: '@机器人 第二条窗口外原文',
      receivedAt: BASE + 2100,
    });

    const result = buildWakeBatch([stored, outside1, outside2]);

    expect(result.packet).toBeNull();
    expect(result.storedOnly.map((entry) => entry.eventId)).toEqual(['g1']);
    expect(result.omitted.map((entry) => entry.eventId)).toEqual(['g2', 'g3']);
    expect(result.omitted.map((entry) => entry.text)).toEqual([
      '@机器人 第一条窗口外原文',
      '@机器人 第二条窗口外原文',
    ]);
    expect(buildWakePacket([stored, outside1, outside2])).toBeNull();
  });

  it('群说话人标签与引用前缀正确，且计入总字符', () => {
    const original = '@机器人 看这个';
    const quote = { fromName: '李四', text: '被引用的原文' };
    const result = buildWakeBatch([
      item({
        eventId: 'g4',
        sessionKey: 'group:9',
        kind: 'group',
        speaker: '张三',
        quote,
        isAtBot: true,
        text: original,
      }),
    ]);

    expect(result.packet?.modelText).toBe(
      '[群友] 张三：[引用 李四：被引用的原文] @机器人 看这个',
    );
    expect(result.packet?.items[0]?.text).toBe(original);
    expect(result.packet?.items[0]?.quote).toEqual(quote);
    expect(result.packet?.totalChars).toBe(charCount(result.packet?.modelText ?? ''));
  });

  it('长正文按单条 300 字截断，items[].text 仍保真', () => {
    const original = '原'.repeat(500);
    const result = buildWakeBatch([item({ text: original })]);

    expect(result.packet?.items[0]?.text).toBe(original);
    expect(result.packet?.truncatedCount).toBe(1);
    expect(charCount(result.packet?.modelText ?? '')).toBe(300);
    expect(result.packet?.modelText).toContain('已截断');
  });

  it('12 条硬上限：第 13 条进入 omittedEventIds，原文不丢', () => {
    const items = Array.from({ length: 13 }, (_, index) =>
      item({
        eventId: `g${index + 1}`,
        sessionKey: 'group:9',
        kind: 'group',
        speaker: '张三',
        isAtBot: true,
        text: `原文 ${index + 1}`,
        receivedAt: BASE + index * 10,
      }),
    );

    const result = buildWakeBatch(items);

    expect(result.packet?.items).toHaveLength(12);
    expect(result.packet?.omittedEventIds).toEqual(['g13']);
    expect(result.packet?.modelText).toContain('已省略 1 条');
    expect(result.packet?.totalChars).toBeLessThanOrEqual(4000);
    expect(result.omitted.map((entry) => entry.text)).toEqual(['原文 13']);

    const next = buildWakeBatch(
      items.filter((entry) => result.packet?.omittedEventIds.includes(entry.eventId)),
    );
    expect(next.packet?.items.map((entry) => entry.text)).toEqual(['原文 13']);
  });

  it('WakePacket 严格保持冻结形状，不混入线上或内部字段', () => {
    const result = buildWakeBatch([item({ text: '形状检查' })]);
    const packet = result.packet!;

    expect(Object.keys(packet).sort()).toEqual(
      ['items', 'modelText', 'omittedEventIds', 'sessionKey', 'totalChars', 'truncatedCount'].sort(),
    );
    expect(Object.keys(packet.items[0]!).sort()).toEqual(
      ['at', 'eventId', 'quote', 'speaker', 'text'].sort(),
    );
    expect(packet.items[0]).not.toHaveProperty('kind');
    expect(packet.items[0]).not.toHaveProperty('isAtBot');
    expect(packet).not.toHaveProperty('storedOnly');
  });

  it('origin 从 InboxItem 透传；缺失时不伪造', () => {
    const live = buildWakeBatch([item({ origin: 'live' })]);
    expect(live.packet?.items[0]?.origin).toBe('live');

    const recovered = buildWakeBatch([item({ origin: 'recovered' })]);
    expect(recovered.packet?.items[0]?.origin).toBe('recovered');

    const missing = buildWakeBatch([item()]);
    expect(missing.packet?.items[0]).not.toHaveProperty('origin');
  });

  it('空输入返回只保存信号且不生成包', () => {
    expect(buildWakeBatch([])).toEqual({ packet: null, storedOnly: [], omitted: [] });
    expect(buildWakePacket([])).toBeNull();
  });

  it('sessionKey 缺省取首条，显式传入时覆盖', () => {
    expect(buildWakePacket([item()])?.sessionKey).toBe('private:1');
    expect(buildWakePacket([item()], { sessionKey: 'private:custom' })?.sessionKey).toBe(
      'private:custom',
    );
  });
});
