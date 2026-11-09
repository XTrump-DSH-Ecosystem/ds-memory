import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventStore } from '../../src/memory/store.ts';
import { TEXT_LIMIT } from '../../src/util/string.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'xds-store-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('EventStore', () => {
  it('按本地月份分片', () => {
    let clock = new Date(2026, 0, 31, 12, 0, 0).getTime();
    const store = new EventStore({ dir, now: () => clock });

    store.append({ src: 'cli', sessionKey: 's1', role: 'user', text: '一月' });
    clock = new Date(2026, 1, 1, 12, 0, 0).getTime();
    store.append({ src: 'cli', sessionKey: 's1', role: 'assistant', text: '二月' });

    expect(existsSync(join(dir, '2026-01.jsonl'))).toBe(true);
    expect(existsSync(join(dir, '2026-02.jsonl'))).toBe(true);
    expect(store.readMonth('2026-01')).toHaveLength(1);
    expect(store.readMonth('2026-02')[0]?.text).toBe('二月');
  });

  it('同 id 去重', () => {
    const store = new EventStore({ dir, now: () => 1_700_000_000_000 });

    const first = store.append({
      id: 'dup-1',
      src: 'cli',
      sessionKey: 's1',
      role: 'user',
      text: '只应出现一次',
    });
    const second = store.append({
      id: 'dup-1',
      src: 'cli',
      sessionKey: 's1',
      role: 'user',
      text: '重复内容',
    });

    expect(first).not.toBeNull();
    expect(second).toBeNull();

    const lines = readFileSync(join(dir, '2023-11.jsonl'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
  });

  it('appendResult 区分 inserted 与 duplicate，append 保持兼容', () => {
    const store = new EventStore({ dir, now: () => 1_700_000_000_000 });

    const inserted = store.appendResult({
      id: 'state-1',
      src: 'qq',
      sessionKey: 'private:1',
      role: 'user',
      text: '三态写入',
    });
    expect(inserted.kind).toBe('inserted');
    if (inserted.kind !== 'inserted') throw new Error('应当 inserted');
    expect(inserted.record).toMatchObject({ id: 'state-1', text: '三态写入' });

    const duplicate = store.appendResult({
      id: 'state-1',
      src: 'qq',
      sessionKey: 'private:1',
      role: 'user',
      text: '重复内容',
    });
    expect(duplicate.kind).toBe('duplicate');
    if (duplicate.kind !== 'duplicate') throw new Error('应当 duplicate');
    expect(duplicate.record).toEqual(inserted.record);
    expect(duplicate.record).toMatchObject({
      id: 'state-1',
      src: 'qq',
      role: 'user',
      text: '三态写入',
    });

    const linesAfterDuplicate = readFileSync(join(dir, '2023-11.jsonl'), 'utf8').trim().split('\n');
    expect(linesAfterDuplicate).toHaveLength(1);

    expect(
      store.append({
        id: 'state-1',
        src: 'qq',
        sessionKey: 'private:1',
        role: 'user',
        text: '兼容包装',
      }),
    ).toBeNull();

    expect(
      store.append({
        id: 'state-2',
        src: 'cli',
        sessionKey: 's1',
        role: 'user',
        text: '新记录',
      })?.id,
    ).toBe('state-2');

    expect(store.readMonth('2023-11')).toHaveLength(2);
  });

  it('重建索引后 duplicate 仍同步返回完整原记录', () => {
    const first = new EventStore({ dir, now: () => 1_700_000_000_000 });
    const inserted = first.appendResult({
      id: 'restart-dup',
      src: 'qq',
      sessionKey: 'group:9',
      role: 'assistant',
      text: '重启前的原记录',
      speaker: '甲',
      quote: { fromName: '乙', text: '引用原文' },
      isAtBot: true,
    });
    if (inserted.kind !== 'inserted') throw new Error('应当 inserted');

    const second = new EventStore({ dir, now: () => 1_700_000_000_000 });
    const duplicate = second.appendResult({
      id: 'restart-dup',
      src: 'cli',
      sessionKey: 's1',
      role: 'user',
      text: '不应覆盖原记录',
    });

    expect(duplicate.kind).toBe('duplicate');
    if (duplicate.kind !== 'duplicate') throw new Error('应当 duplicate');
    expect(duplicate.record).toEqual(inserted.record);
    expect(duplicate.record).toMatchObject({
      src: 'qq',
      role: 'assistant',
      text: '重启前的原记录',
      speaker: '甲',
      quote: { fromName: '乙', text: '引用原文' },
      isAtBot: true,
    });
    expect(second.readMonth('2023-11')).toHaveLength(1);
  });

  it('appendResult 写入失败返回 write_error，append 仍兼容告警', () => {
    const blocked = join(dir, 'blocked-result');
    writeFileSync(blocked, 'not a directory', 'utf8');
    const warnings: string[] = [];
    const store = new EventStore({
      dir: blocked,
      now: () => 1_700_000_000_000,
      onWarn: (message) => warnings.push(message),
    });

    const result = store.appendResult({
      id: 'fail-1',
      src: 'qq',
      sessionKey: 'private:1',
      role: 'user',
      text: '写失败',
    });

    expect(result.kind).toBe('write_error');
    if (result.kind !== 'write_error') throw new Error('应当 write_error');
    expect(result.message.length).toBeGreaterThan(0);

    expect(
      store.append({
        id: 'fail-2',
        src: 'qq',
        sessionKey: 'private:1',
        role: 'user',
        text: '兼容包装仍返回 null',
      }),
    ).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('L0 写入失败');
    expect(warnings[0]).toContain(result.message);
  });

  it('超长文本完整落盘（L0 原文不截断）', () => {
    const store = new EventStore({ dir, now: () => new Date(2026, 2, 2, 12).getTime() });
    const text = '字'.repeat(TEXT_LIMIT + 500);
    const record = store.append({
      src: 'cli',
      sessionKey: 's1',
      role: 'user',
      text,
    });

    expect(record).not.toBeNull();
    expect(record?.text).toBe(text);
    expect(Array.from(record?.text ?? '').length).toBe(TEXT_LIMIT + 500);

    const stored = JSON.parse(readFileSync(join(dir, '2026-03.jsonl'), 'utf8').trim());
    expect(stored.text).toBe(text);
  });

  it('speaker/quote 作为独立元数据落盘并可读回', () => {
    const store = new EventStore({ dir, now: () => new Date(2026, 2, 2, 12).getTime() });
    const quote = { fromName: '张三', text: '被引用的原文' };

    const record = store.append({
      id: 'qq-1',
      src: 'qq',
      sessionKey: 'group:100',
      role: 'user',
      text: '@bot 完整原文',
      speaker: '李四',
      quote,
    });

    expect(record).toMatchObject({ speaker: '李四', quote, text: '@bot 完整原文' });
    expect(store.readMonth('2026-03')).toEqual([record]);
  });

  it('isAtBot 作为独立元数据落盘并可读回', () => {
    const store = new EventStore({ dir, now: () => new Date(2026, 4, 2, 12).getTime() });

    const atBot = store.appendResult({
      id: 'qq-at',
      src: 'qq',
      sessionKey: 'group:100',
      role: 'user',
      text: '@bot 完整原文',
      speaker: '李四',
      isAtBot: true,
    });
    const plain = store.appendResult({
      id: 'qq-plain',
      src: 'qq',
      sessionKey: 'group:100',
      role: 'user',
      text: '普通群消息',
      speaker: '王五',
      isAtBot: false,
    });

    if (atBot.kind !== 'inserted' || plain.kind !== 'inserted') {
      throw new Error('应当 inserted');
    }
    expect(atBot.record.text).toBe('@bot 完整原文');
    expect(atBot.record.isAtBot).toBe(true);
    expect(plain.record.isAtBot).toBe(false);

    const records = store.readMonth('2026-05');
    expect(records.map((record) => [record.id, record.isAtBot, record.text])).toEqual([
      ['qq-at', true, '@bot 完整原文'],
      ['qq-plain', false, '普通群消息'],
    ]);
    expect(records[0]?.text).not.toContain('isAtBot');

    const stored = JSON.parse(readFileSync(join(dir, '2026-05.jsonl'), 'utf8').trim().split('\n')[0]!);
    expect(stored.isAtBot).toBe(true);
    expect(stored.text).toBe('@bot 完整原文');
  });

  it('senderQqId/modelEligible 作为独立元数据落盘并可读回', () => {
    const store = new EventStore({ dir, now: () => new Date(2026, 5, 2, 12).getTime() });

    const owner = store.appendResult({
      id: 'qq-owner',
      src: 'qq',
      sessionKey: 'group:100',
      role: 'user',
      text: 'owner 原文',
      senderQqId: '123456789',
      modelEligible: true,
    });
    const member = store.appendResult({
      id: 'qq-member',
      src: 'qq',
      sessionKey: 'group:100',
      role: 'user',
      text: '群友原文',
      senderQqId: '222333444',
      modelEligible: false,
    });

    if (owner.kind !== 'inserted' || member.kind !== 'inserted') {
      throw new Error('应当 inserted');
    }
    expect(owner.record.senderQqId).toBe('123456789');
    expect(owner.record.modelEligible).toBe(true);
    expect(member.record.senderQqId).toBe('222333444');
    expect(member.record.modelEligible).toBe(false);

    const records = store.readMonth('2026-06');
    expect(records.map((record) => [record.id, record.senderQqId, record.modelEligible, record.text])).toEqual([
      ['qq-owner', '123456789', true, 'owner 原文'],
      ['qq-member', '222333444', false, '群友原文'],
    ]);
    expect(records[0]?.text).toBe('owner 原文');
  });

  it('旧记录缺少 speaker/quote/isAtBot 仍可读取并参与去重', () => {
    const shard = join(dir, '2026-04.jsonl');
    const legacy = {
      id: 'legacy-1',
      src: 'qq',
      sessionKey: 'private:123',
      t: '2026-04-01T04:00:00.000Z',
      role: 'user',
      text: '旧版原文',
    };
    writeFileSync(shard, `${JSON.stringify(legacy)}\n`, 'utf8');

    const store = new EventStore({ dir, now: () => new Date(2026, 3, 2, 12).getTime() });
    const [read] = store.readMonth('2026-04');

    expect(read).toEqual(legacy);
    expect(read?.speaker).toBeUndefined();
    expect(read?.quote).toBeUndefined();
    expect(read?.isAtBot).toBeUndefined();
    expect(
      store.append({
        id: 'legacy-1',
        src: 'qq',
        sessionKey: 'private:123',
        role: 'user',
        text: '重复',
      }),
    ).toBeNull();
  });

  it('损坏行跳过，不影响去重与追加', () => {
    const shard = join(dir, '2026-03.jsonl');
    const valid = {
      id: 'old-1',
      src: 'cli',
      sessionKey: 's1',
      t: '2026-03-01T04:00:00.000Z',
      role: 'user',
      text: '旧记录',
    };
    writeFileSync(shard, `这一行不是 JSON\n${JSON.stringify(valid)}\n`, 'utf8');

    const store = new EventStore({ dir, now: () => new Date(2026, 2, 2, 12).getTime() });

    expect(
      store.append({ id: 'old-1', src: 'cli', sessionKey: 's1', role: 'user', text: '重复' }),
    ).toBeNull();

    const added = store.append({
      id: 'new-1',
      src: 'cli',
      sessionKey: 's1',
      role: 'user',
      text: '新记录',
    });
    expect(added).not.toBeNull();

    const lines = readFileSync(shard, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('这一行不是 JSON');
    expect(store.readMonth('2026-03').map((r) => r.id)).toEqual(['old-1', 'new-1']);
  });

  it('写入失败只告警一次且不抛错', () => {
    const blocked = join(dir, 'blocked');
    writeFileSync(blocked, 'not a directory', 'utf8');
    const warnings: string[] = [];
    const store = new EventStore({
      dir: blocked,
      now: () => 1_700_000_000_000,
      onWarn: (message) => warnings.push(message),
    });

    expect(
      store.append({ src: 'cli', sessionKey: 's1', role: 'user', text: '一' }),
    ).toBeNull();
    expect(
      store.append({ src: 'cli', sessionKey: 's1', role: 'user', text: '二' }),
    ).toBeNull();
    expect(warnings).toHaveLength(1);
  });
});
