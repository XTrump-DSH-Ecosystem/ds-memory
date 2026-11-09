import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SelfNoteStore } from '../../src/memory/selfnote.ts';

let dir: string;
let clock: number;

function makeStore(max = 40, bootstrapLimit = 20): SelfNoteStore {
  return new SelfNoteStore({ dir, max, bootstrapLimit, now: () => clock, onWarn: () => {} });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'xds-selfnote-'));
  clock = 1_700_000_000_000;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('SelfNoteStore', () => {
  it('同文本去重，只刷新 lastTouchedAt', () => {
    const store = makeStore();
    const first = store.upsert('cli:test', '我说话要更简短')!;
    clock += 1_000;
    const second = store.upsert('cli:test', '我说话要更简短')!;

    expect(second.id).toBe(first.id);
    expect(second.createdAt).toBe(first.createdAt);
    expect(Date.parse(second.lastTouchedAt)).toBeGreaterThan(Date.parse(first.lastTouchedAt));
    expect(store.count('cli:test')).toBe(1);
  });

  it('总数上限按 lastTouchedAt 淘汰最旧', () => {
    const store = makeStore(3);
    for (let i = 0; i < 5; i += 1) {
      clock += 1_000;
      store.upsert('cli:test', `第${i}条自认知`);
    }

    const texts = store.list('cli:test').map((note) => note.text);
    expect(texts).toEqual(['第2条自认知', '第3条自认知', '第4条自认知']);
  });

  it('bootstrapText 只取最近 N 条并带框定', () => {
    const store = makeStore(40, 2);
    for (let i = 0; i < 4; i += 1) {
      clock += 1_000;
      store.upsert('cli:test', `第${i}条自认知`);
    }

    const text = store.bootstrapText('cli:test');
    expect(text).toContain('【你对自己的认识】');
    expect(text).toContain('第2条自认知');
    expect(text).toContain('第3条自认知');
    expect(text).not.toContain('第0条自认知');
    expect(text.split('\n').filter((line) => line.startsWith('- '))).toHaveLength(2);
  });

  it('bootstrapText 不再展示旧自动称呼偏好，只展示普通 selfNote', () => {
    const store = makeStore(40, 3);
    store.upsert(
      'cli:test',
      '主人指定的称呼是「鱼鱼」。这是称呼偏好，不是身份改变；主人这样称呼时正常回应。',
    );
    clock += 1_000;
    store.upsert('cli:test', '第一条普通自认知');
    clock += 1_000;
    store.upsert('cli:test', '第二条普通自认知');
    clock += 1_000;
    store.upsert(
      'cli:test',
      '主人指定的称呼是「大肥鱼」。这是称呼偏好，不是身份改变；主人这样称呼时正常回应。',
    );

    const text = store.bootstrapText('cli:test');
    expect(text).toContain('【你对自己的认识】');
    expect(text).toContain('第一条普通自认知');
    expect(text).toContain('第二条普通自认知');
    expect(text).not.toContain('主人指定的称呼是');
    expect(text).not.toContain('【主人当前指定的称呼】');
  });

  it('bootstrapText 的 bootstrapLimit 只计算普通 selfNote', () => {
    const store = makeStore(40, 1);
    store.upsert(
      'cli:test',
      '主人指定的称呼是「大肥鱼」。这是称呼偏好，不是身份改变；主人这样称呼时正常回应。',
    );
    clock += 1_000;
    store.upsert('cli:test', '第一条普通自认知');
    clock += 1_000;
    store.upsert('cli:test', '第二条普通自认知');

    const text = store.bootstrapText('cli:test');
    expect(text).toContain('第二条普通自认知');
    expect(text).not.toContain('第一条普通自认知');
    expect(text).not.toContain('主人指定的称呼是');
    expect(text.split('\n').filter((line) => line.startsWith('- '))).toHaveLength(1);
  });

  it('只有旧自动称呼偏好时 bootstrapText 为空，原文仍保留', () => {
    const store = makeStore();
    store.upsert('cli:test', '主人指定的称呼是「鱼鱼」。这是称呼偏好。');

    expect(store.bootstrapText('cli:test')).toBe('');
    expect(store.count('cli:test')).toBe(1);
    expect(readFileSync(join(dir, 'cli_test.jsonl'), 'utf8')).toContain(
      '主人指定的称呼是「鱼鱼」',
    );
  });

  it('没有笔记时 bootstrapText 为空串', () => {
    const store = makeStore();
    expect(store.bootstrapText('cli:test')).toBe('');
  });

  it('archiveMatching 只归档匹配项，list/bootstrap/count 立即排除', () => {
    const store = makeStore();
    store.upsert('cli:test', '旧的称呼是「小鲸鱼」，不接受改叫');
    store.upsert('cli:test', '我说话要更简短');

    const archived = store.archiveMatching('cli:test', (note) =>
      note.text.includes('称呼'),
    );

    expect(archived).toBe(1);
    expect(store.count('cli:test')).toBe(1);
    expect(store.list('cli:test').map((note) => note.text)).toEqual([
      '我说话要更简短',
    ]);
    expect(store.bootstrapText('cli:test')).not.toContain('小鲸鱼');
    expect(store.bootstrapText('cli:test')).toContain('我说话要更简短');
  });

  it('归档只追加 archived 修订，原文仍在文件里；重启后仍不加载', () => {
    const store = makeStore();
    const old = store.upsert('cli:test', '旧称呼：小鲸鱼')!;
    expect(store.archiveMatching('cli:test', (note) => note.id === old.id)).toBe(1);

    const file = readFileSync(join(dir, 'cli_test.jsonl'), 'utf8');
    expect(file).toContain('旧称呼：小鲸鱼');
    expect(file).toContain('"archived":true');

    const restarted = makeStore();
    expect(restarted.list('cli:test')).toEqual([]);
    expect(restarted.count('cli:test')).toBe(0);
    expect(restarted.bootstrapText('cli:test')).toBe('');
  });

  it('同文本去重只看未归档记录；归档后同文本可重新写入', () => {
    const store = makeStore();
    const old = store.upsert('cli:test', '我说话要更简短')!;
    store.archiveMatching('cli:test', (note) => note.id === old.id);

    clock += 1_000;
    const fresh = store.upsert('cli:test', '我说话要更简短')!;
    expect(fresh.id).not.toBe(old.id);
    expect(store.count('cli:test')).toBe(1);
    expect(store.list('cli:test').map((note) => note.id)).toEqual([fresh.id]);
  });
});
