import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FactsStore, type FactsOptions } from '../../src/memory/facts.ts';

const DAY = 86_400_000;

let dir: string;
let clock: number;

function makeStore(overrides: Partial<FactsOptions> = {}): FactsStore {
  return new FactsStore({
    dir,
    halfLifeDays: 45,
    archiveThreshold: 1,
    injectMax: 30,
    injectMaxChars: 900,
    now: () => clock,
    onWarn: () => {},
    ...overrides,
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'xds-facts-'));
  clock = 1_700_000_000_000;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('facts 权重数学', () => {
  it('默认半衰期：45 天后权重减半', () => {
    const store = makeStore();
    const { record } = store.upsert('cli:test', '他叫小鲸鱼', 'identity')!;

    expect(store.weightOf(record)).toBeCloseTo(3, 6);
    clock += 45 * DAY;
    expect(store.weightOf(record)).toBeCloseTo(1.5, 6);
  });

  it('复习拉长半衰期（忘得更慢）', () => {
    const store = makeStore();
    store.upsert('cli:test', '他叫小鲸鱼', 'identity');
    const { record } = store.upsert('cli:test', '他叫小鲸鱼', 'identity')!;
    expect(record.reviews).toBe(1);

    clock += 45 * DAY;
    // h = 45 × (1 + 0.5 × 1) = 67.5 → 3 × 2^(−45/67.5) ≈ 1.89 > 1.5
    expect(store.weightOf(record)).toBeGreaterThan(1.5);
    expect(store.weightOf(record)).toBeCloseTo(1.891, 2);
  });

  it('复习 8 次后封顶（再复习不再拉长半衰期）', () => {
    const store = makeStore();
    for (let i = 0; i < 8; i += 1) store.upsert('cli:test', '他叫小鲸鱼', 'identity');
    const { record: eight } = store.upsert('cli:test', '他叫小鲸鱼', 'identity')!;
    expect(eight.reviews).toBe(8);

    clock += 45 * DAY;
    const weightAt8 = store.weightOf(eight);

    const { record: twelve } = store.upsert('cli:test', '他叫小鲸鱼', 'identity')!;
    expect(twelve.reviews).toBe(9);
    clock += 45 * DAY;
    expect(store.weightOf(twelve)).toBeCloseTo(weightAt8, 9);
  });
});

describe('facts 注入与归档', () => {
  it('双预算硬截断（条数与字数）', () => {
    const store = makeStore({ injectMax: 10, injectMaxChars: 60 });
    for (let i = 0; i < 100; i += 1) {
      store.upsert('cli:test', `第${i}条记忆`, 'misc');
    }

    const text = store.selectForInjection('cli:test');
    const lines = text.split('\n').filter((line) => line.startsWith('- '));

    expect(lines.length).toBeLessThanOrEqual(10);
    const chars = lines.reduce((sum, line) => sum + Array.from(line.slice(2)).length, 0);
    expect(chars).toBeLessThanOrEqual(60);
    expect(text.split('\n')[0]).toContain(`【长期记忆】${lines.length} 条`);
  });

  it('跌破归档线不再注入，且只归档不删除原文', () => {
    const store = makeStore();
    const { record } = store.upsert('cli:test', '他以前养过一只猫', 'misc')!;
    clock += 200 * DAY; // 1.3 × 2^(−200/45) ≈ 0.06 < 1

    expect(store.selectForInjection('cli:test')).toBe('');
    expect(store.count('cli:test')).toBe(1);

    // 写路径（新写一条）触发归档：旧事实置 archived=true，但原文仍在文件里。
    store.upsert('cli:test', '他现在的猫叫豆豆', 'misc');
    clock -= 200 * DAY;
    expect(store.listLive('cli:test').some((fact) => fact.id === record.id)).toBe(false);

    const file = readFileSync(join(dir, 'cli_test.jsonl'), 'utf8');
    expect(file).toContain('他以前养过一只猫');
    expect(file).toContain('"archived":true');
  });

  it('同文本视为复习，不重复落库', () => {
    const store = makeStore();
    const first = store.upsert('cli:test', '他不吃香菜', 'preference')!;
    expect(first.created).toBe(true);

    const second = store.upsert('cli:test', '他不吃香菜', 'preference')!;
    expect(second.created).toBe(false);
    expect(second.record.id).toBe(first.record.id);
    expect(second.record.reviews).toBe(1);
    expect(store.count('cli:test')).toBe(1);
  });

  it('archiveMatching 只归档匹配项，注入与计数立即排除', () => {
    const store = makeStore();
    const old = store.upsert('cli:test', '主人戏称我为小鲸鱼', 'identity')!.record;
    store.upsert('cli:test', '主人喜欢喝乌龙茶', 'preference');

    const archived = store.archiveMatching('cli:test', (fact) =>
      fact.text.includes('小鲸鱼'),
    );

    expect(archived).toBe(1);
    expect(store.count('cli:test')).toBe(1);
    expect(store.listLive('cli:test').map((fact) => fact.id)).not.toContain(old.id);
    expect(store.selectForInjection('cli:test')).not.toContain('小鲸鱼');
    expect(store.selectForInjection('cli:test')).toContain('乌龙茶');
  });

  it('归档只追加 archived 修订，原文仍在文件里；重启后仍不加载', () => {
    const store = makeStore();
    const old = store.upsert('cli:test', '旧称呼：小鲸鱼', 'identity')!.record;
    expect(store.archiveMatching('cli:test', (fact) => fact.id === old.id)).toBe(1);

    const file = readFileSync(join(dir, 'cli_test.jsonl'), 'utf8');
    expect(file).toContain('旧称呼：小鲸鱼');
    expect(file).toContain('"archived":true');

    const restarted = makeStore();
    expect(restarted.listLive('cli:test')).toEqual([]);
    expect(restarted.count('cli:test')).toBe(0);
    expect(restarted.selectForInjection('cli:test')).toBe('');
  });

  it('同文本去重只看未归档事实；归档后同文本可重新写入', () => {
    const store = makeStore();
    const old = store.upsert('cli:test', '主人喜欢乌龙茶', 'preference')!.record;
    store.archiveMatching('cli:test', (fact) => fact.id === old.id);

    clock += 1_000;
    const fresh = store.upsert('cli:test', '主人喜欢乌龙茶', 'preference')!;
    expect(fresh.created).toBe(true);
    expect(fresh.record.id).not.toBe(old.id);
    expect(store.count('cli:test')).toBe(1);
  });
});

describe('facts 自动复习钩子', () => {
  it('gram 重叠率 ≥ 0.5 时复习一次', () => {
    const store = makeStore();
    store.upsert('cli:test', '不吃香菜', 'preference');

    expect(store.autoReview('cli:test', '我也不吃香菜啊')).toBe(1);
    const reviewed = store.listLive('cli:test')[0]!;
    expect(reviewed.reviews).toBe(1);
  });

  it('显式主体不同时不复习，即使 gram 高度重叠', () => {
    const cases = [
      ['他喜欢猫', '我喜欢猫'],
      ['他喜欢猫', '她喜欢猫'],
    ] as const;

    for (const [index, [factText, incoming]] of cases.entries()) {
      const sessionKey = `cli:different-subject${index}`;
      const store = makeStore();
      store.upsert(sessionKey, factText, 'preference');

      expect(store.autoReview(sessionKey, incoming)).toBe(0);
      expect(store.listLive(sessionKey)[0]!.reviews).toBe(0);
    }
  });

  it('同主体但具体对象不同时不复习，即使 gram 高度重叠', () => {
    const cases = [
      ['他喜欢猫', '他喜欢狗'],
      ['他喜欢猫', '他喜欢猫粮'],
    ] as const;

    for (const [index, [factText, incoming]] of cases.entries()) {
      const sessionKey = `cli:different-object${index}`;
      const store = makeStore();
      store.upsert(sessionKey, factText, 'preference');

      expect(store.autoReview(sessionKey, incoming)).toBe(0);
      expect(store.listLive(sessionKey)[0]!.reviews).toBe(0);
    }
  });

  it('主客倒置时不复习，即使 gram 高度重叠', () => {
    const store = makeStore();
    store.upsert('cli:reversed-roles', '猫喜欢我', 'preference');

    expect(store.autoReview('cli:reversed-roles', '我喜欢猫')).toBe(0);
    expect(store.listLive('cli:reversed-roles')[0]!.reviews).toBe(0);
  });

  it('同主体同对象带强调、程度或地点虚词时仍复习一次', () => {
    const cases = [
      ['他住在杭州', '他住杭州'],
      ['他喜欢猫', '他确实喜欢猫'],
      ['他喜欢猫', '他就是喜欢猫'],
      ['他喜欢猫', '他超级喜欢猫'],
      ['他喜欢猫', '他实在喜欢猫'],
    ] as const;

    for (const [index, [factText, incoming]] of cases.entries()) {
      const sessionKey = `cli:same-assertion${index}`;
      const store = makeStore();
      store.upsert(sessionKey, factText, 'preference');

      expect(store.autoReview(sessionKey, incoming)).toBe(1);
      expect(store.listLive(sessionKey)[0]!.reviews).toBe(1);
    }
  });

  it('同主体同对象通过并列连接词扩展时仍复习一次', () => {
    const store = makeStore();
    store.upsert('cli:coordinated-object', '他喜欢猫', 'preference');

    expect(store.autoReview('cli:coordinated-object', '他喜欢猫和狗')).toBe(1);
    expect(store.listLive('cli:coordinated-object')[0]!.reviews).toBe(1);
  });

  it('旧事实包含多个对象、新消息只提部分对象时不复习', () => {
    const cases = [
      ['他喜欢猫和狗', '他喜欢猫'],
      ['他喜欢猫和狗', '他喜欢狗'],
      ['他喜欢猫和狗', '他喜欢狗和猫'],
    ] as const;

    for (const [index, [factText, incoming]] of cases.entries()) {
      const sessionKey = `cli:partial-object${index}`;
      const store = makeStore();
      store.upsert(sessionKey, factText, 'preference');

      expect(store.autoReview(sessionKey, incoming)).toBe(0);
      expect(store.listLive(sessionKey)[0]!.reviews).toBe(0);
    }
  });

  it('并列连接词后没有实际对象时不复习', () => {
    const cases = ['他喜欢猫和', '他喜欢猫和，', '他喜欢猫和 '] as const;

    for (const [index, incoming] of cases.entries()) {
      const sessionKey = `cli:empty-coordination${index}`;
      const store = makeStore();
      store.upsert(sessionKey, '他喜欢猫', 'preference');

      expect(store.autoReview(sessionKey, incoming)).toBe(0);
      expect(store.listLive(sessionKey)[0]!.reviews).toBe(0);
    }
  });

  it('选择关系不按并列扩展复习', () => {
    const cases = [
      ['他喜欢猫', '他喜欢猫还是狗'],
      ['他喜欢猫和狗', '他喜欢猫还是狗'],
    ] as const;

    for (const [index, [factText, incoming]] of cases.entries()) {
      const sessionKey = `cli:alternative${index}`;
      const store = makeStore();
      store.upsert(sessionKey, factText, 'preference');

      expect(store.autoReview(sessionKey, incoming)).toBe(0);
      expect(store.listLive(sessionKey)[0]!.reviews).toBe(0);
    }
  });

  it('全局噪声不折叠含“挺”的独立内容', () => {
    const cases = [
      ['他挺过去了', '他过去了'],
      ['张挺喜欢猫', '张喜欢猫'],
    ] as const;

    for (const [index, [factText, incoming]] of cases.entries()) {
      const sessionKey = `cli:ting-content${index}`;
      const store = makeStore();
      store.upsert(sessionKey, factText, 'preference');

      expect(store.autoReview(sessionKey, incoming)).toBe(0);
      expect(store.listLive(sessionKey)[0]!.reviews).toBe(0);
    }
  });

  it('同主体同对象出现在多分句之一时仍复习一次', () => {
    const cases = [
      ['我喜欢猫', '我喜欢猫，但不喜欢狗'],
      ['我不喜欢猫', '我喜欢狗，不喜欢猫'],
    ] as const;

    for (const [index, [factText, incoming]] of cases.entries()) {
      const sessionKey = `cli:multi-clause${index}`;
      const store = makeStore();
      store.upsert(sessionKey, factText, 'preference');

      expect(store.autoReview(sessionKey, incoming)).toBe(1);
      expect(store.listLive(sessionKey)[0]!.reviews).toBe(1);
    }
  });

  it('不相关的新消息不复习', () => {
    const store = makeStore();
    store.upsert('cli:test', '不吃香菜', 'preference');

    expect(store.autoReview('cli:test', '今天天气不错')).toBe(0);
    expect(store.listLive('cli:test')[0]!.reviews).toBe(0);
  });

  it('live facts 超过 200 条时只比对权重前 50 条', () => {
    const store = makeStore();
    for (let i = 0; i < 200; i += 1) {
      store.upsert('cli:test', `身份事实编号${i}号`, 'identity');
    }
    store.upsert('cli:test', '不吃香菜', 'misc');

    // 匹配的 misc 权重最低（1.3 < 3.0），排在第 201 位，不在前 50 里。
    expect(store.autoReview('cli:test', '我也不吃香菜啊')).toBe(0);
  });
});

describe('facts 可塑性（强冲突降权）', () => {
  it('否定极性翻转的强冲突把旧事实权重减半，并留下 conflictedAt', () => {
    const store = makeStore();
    const old = store.upsert('cli:test', '他不吃香菜', 'preference')!.record;

    const incoming = store.upsert('cli:test', '他现在吃香菜', 'preference')!.record;
    expect(incoming.text).toBe('他现在吃香菜');

    const after = store.listLive('cli:test').find((fact) => fact.id === old.id)!;
    expect(after.baseWeight).toBeCloseTo(1.25, 6);
    expect(after.conflictedAt).toBeTruthy();
    expect(after.text).toBe('他不吃香菜');
    expect(after.reviews).toBe(0);
  });

  it('每条旧事实只降权一次，连续冲突不会指数级衰减', () => {
    const store = makeStore();
    const old = store.upsert('cli:test', '他不吃香菜', 'preference')!.record;
    store.upsert('cli:test', '他现在吃香菜', 'preference');
    store.upsert('cli:test', '他后来也吃香菜', 'preference');

    const after = store.listLive('cli:test').find((fact) => fact.id === old.id)!;
    expect(after.baseWeight).toBeCloseTo(1.25, 6);
  });

  it('不同 tag 或不同主题不降权', () => {
    const store = makeStore();
    const old = store.upsert('cli:test', '他不吃香菜', 'preference')!.record;

    store.upsert('cli:test', '他现在吃香菜', 'misc');
    store.upsert('cli:test', '他现在养狗', 'preference');

    const after = store.listLive('cli:test').find((fact) => fact.id === old.id)!;
    expect(after.baseWeight).toBe(2.5);
    expect(after.conflictedAt).toBeUndefined();
  });

  it('完全相同文本只走复习，不触发冲突降权', () => {
    const store = makeStore();
    const old = store.upsert('cli:test', '他不吃香菜', 'preference')!.record;
    const again = store.upsert('cli:test', '他不吃香菜', 'preference')!;

    expect(again.created).toBe(false);
    expect(again.record.id).toBe(old.id);
    expect(again.record.reviews).toBe(1);
    expect(again.record.baseWeight).toBe(2.5);
    expect(again.record.conflictedAt).toBeUndefined();
  });

  it('强冲突消息不被 autoReview 当成再次确认', () => {
    const store = makeStore();
    store.upsert('cli:test', '他不吃香菜', 'preference');

    expect(store.autoReview('cli:test', '我现在吃香菜')).toBe(0);
    expect(store.listLive('cli:test')[0]!.reviews).toBe(0);
  });

  it('短事实的反义也降权，autoReview 不强化', () => {
    const store = makeStore();
    const old = store.upsert('cli:test', '他吃辣', 'preference')!.record;

    expect(store.autoReview('cli:test', '他不吃辣')).toBe(0);
    const viaReview = store.listLive('cli:test').find((fact) => fact.id === old.id)!;
    expect(viaReview.reviews).toBe(0);

    store.upsert('cli:test', '他不吃辣', 'preference');
    const after = store.listLive('cli:test').find((fact) => fact.id === old.id)!;
    expect(after.baseWeight).toBeCloseTo(1.25, 6);
    expect(after.conflictedAt).toBeTruthy();
  });

  it('分句极性按局部判断：不因无关分句否定误降权或误跳过复习', () => {
    const conflictStore = makeStore();
    const old = conflictStore.upsert('cli:test', '他不在北京但喜欢猫', 'preference')!.record;

    conflictStore.upsert('cli:test', '她喜欢猫', 'preference');
    const after = conflictStore.listLive('cli:test').find((fact) => fact.id === old.id)!;
    expect(after.baseWeight).toBe(2.5);
    expect(after.conflictedAt).toBeUndefined();

    const reviewStore = makeStore();
    reviewStore.upsert('cli:review', '我喜欢猫', 'preference');
    expect(reviewStore.autoReview('cli:review', '我喜欢猫，但不喜欢狗')).toBe(1);
    expect(reviewStore.listLive('cli:review')[0]!.reviews).toBe(1);
  });

  it('相关反义分句不会被无关同极性分句抵消', () => {
    const cases = [
      ['cli:case1', '我喜欢猫', '我喜欢狗，不喜欢猫'],
      ['cli:case2', '他不在北京', '他在北京，不在上海'],
      ['cli:case3', '他吃辣', '他吃火锅但不吃辣'],
    ] as const;

    for (const [sessionKey, oldText, incoming] of cases) {
      const store = makeStore();
      const old = store.upsert(sessionKey, oldText, 'preference')!.record;

      expect(store.autoReview(sessionKey, incoming)).toBe(0);
      store.upsert(sessionKey, incoming, 'preference');
      const after = store.listLive(sessionKey).find((fact) => fact.id === old.id)!;
      expect(after.baseWeight).toBeCloseTo(1.25, 6);
      expect(after.conflictedAt).toBeTruthy();
    }
  });

  it('而不/而非 分句与同极性具体对象不会被误判', () => {
    const restoreStore = makeStore();
    const old = restoreStore.upsert('cli:restore', '我喜欢猫', 'preference')!.record;
    expect(restoreStore.autoReview('cli:restore', '我喜欢猫而不喜欢狗')).toBe(1);
    restoreStore.upsert('cli:restore', '我喜欢猫而不喜欢狗', 'preference');
    const restored = restoreStore.listLive('cli:restore').find((fact) => fact.id === old.id)!;
    expect(restored.baseWeight).toBe(2.5);
    expect(restored.conflictedAt).toBeUndefined();

    const confirmStore = makeStore();
    const disliked = confirmStore.upsert('cli:confirm', '我不喜欢猫', 'preference')!.record;
    expect(confirmStore.autoReview('cli:confirm', '我喜欢狗，不喜欢猫')).toBe(1);
    confirmStore.upsert('cli:confirm', '我喜欢狗，不喜欢猫', 'preference');
    const confirmed = confirmStore.listLive('cli:confirm').find((fact) => fact.id === disliked.id)!;
    expect(confirmed.baseWeight).toBe(2.5);
    expect(confirmed.conflictedAt).toBeUndefined();
  });

  it('代词宾语与否定变体：明确反义降权，不能作为“再次确认”', () => {
    const cases = [
      ['我喜欢你', '我不喜欢你'],
      ['他喜欢她', '他不喜欢她'],
      ['我吃辣', '我不能吃辣'],
      ['我养猫', '我没有养猫'],
      ['我喜欢猫', '我并不喜欢猫'],
      ['我喜欢猫', '我一点也不喜欢猫'],
    ] as const;

    for (const [index, [oldText, incoming]] of cases.entries()) {
      const store = makeStore();
      const sessionKey = `cli:negation${index}`;
      const old = store.upsert(sessionKey, oldText, 'preference')!.record;

      expect(store.autoReview(sessionKey, incoming)).toBe(0);
      store.upsert(sessionKey, incoming, 'preference');
      const after = store.listLive(sessionKey).find((fact) => fact.id === old.id)!;
      expect(after.baseWeight).toBeCloseTo(1.25, 6);
      expect(after.conflictedAt).toBeTruthy();
    }
  });

  it('不同主体/角色/否定程度不能误降权，也不能被当成再次确认', () => {
    const cases = [
      ['他喜欢猫', '我不喜欢猫'],
      ['他喜欢猫', '她不喜欢猫'],
      ['猫喜欢我', '我不喜欢猫'],
      ['我喜欢猫', '猫不喜欢我'],
      ['我喜欢猫', '我不讨厌猫'],
      ['我讨厌猫', '我不讨厌猫'],
    ] as const;

    for (const [index, [oldText, incoming]] of cases.entries()) {
      const store = makeStore();
      const sessionKey = `cli:uncertain${index}`;
      const old = store.upsert(sessionKey, oldText, 'preference')!.record;

      expect(store.autoReview(sessionKey, incoming)).toBe(0);
      store.upsert(sessionKey, incoming, 'preference');
      const after = store.listLive(sessionKey).find((fact) => fact.id === old.id)!;
      expect(after.baseWeight).toBe(2.5);
      expect(after.conflictedAt).toBeUndefined();
      expect(after.reviews).toBe(0);
    }

    const degreeStore = makeStore();
    const degreeOld = degreeStore.upsert('cli:degree', '我不喜欢猫', 'preference')!.record;
    expect(degreeStore.autoReview('cli:degree', '我不太喜欢猫')).toBe(1);
    degreeStore.upsert('cli:degree', '我不太喜欢猫', 'preference');
    const degreeAfter = degreeStore
      .listLive('cli:degree')
      .find((fact) => fact.id === degreeOld.id)!;
    expect(degreeAfter.baseWeight).toBe(2.5);
    expect(degreeAfter.conflictedAt).toBeUndefined();
  });

  it('叠加否定按中性处理：不降权、不复习', () => {
    const cases = [
      ['我喜欢猫', '我并非不喜欢猫'],
      ['我不喜欢猫', '我并非不喜欢猫'],
      ['我喜欢猫', '我没有不喜欢猫'],
      ['我并非不喜欢猫', '我喜欢猫'],
    ] as const;

    for (const [index, [oldText, incoming]] of cases.entries()) {
      const store = makeStore();
      const sessionKey = `cli:double-negative${index}`;
      const old = store.upsert(sessionKey, oldText, 'preference')!.record;

      expect(store.autoReview(sessionKey, incoming)).toBe(0);
      store.upsert(sessionKey, incoming, 'preference');
      const after = store.listLive(sessionKey).find((fact) => fact.id === old.id)!;
      expect(after.baseWeight).toBe(2.5);
      expect(after.conflictedAt).toBeUndefined();
      expect(after.reviews).toBe(0);
    }
  });

  it('未/从未/并未 是否定：明确反义仍降权', () => {
    const cases = [
      ['我吃辣', '我未吃辣'],
      ['我吃辣', '我从未吃辣'],
      ['我吃辣', '我并未吃辣'],
    ] as const;

    for (const [index, [oldText, incoming]] of cases.entries()) {
      const store = makeStore();
      const sessionKey = `cli:wei-negation${index}`;
      const old = store.upsert(sessionKey, oldText, 'preference')!.record;

      expect(store.autoReview(sessionKey, incoming)).toBe(0);
      store.upsert(sessionKey, incoming, 'preference');
      const after = store.listLive(sessionKey).find((fact) => fact.id === old.id)!;
      expect(after.baseWeight).toBeCloseTo(1.25, 6);
      expect(after.conflictedAt).toBeTruthy();
    }
  });

  it('多分句省略主语继承前序主语，不跨主体误降权', () => {
    const cases = [
      ['他不在北京但喜欢猫', '她不喜欢猫'],
      ['他不在北京但喜欢猫', '我不喜欢猫'],
      ['他不在北京但一直喜欢猫', '我不喜欢猫'],
      ['他不在北京但现在喜欢猫', '她不喜欢猫'],
      ['他不在北京但特别喜欢猫', '我不喜欢猫'],
      ['他不在北京但以前喜欢猫', '她不喜欢猫'],
      ['他不在北京但怕猫', '她不怕猫'],
      ['喜欢猫', '她不喜欢猫'],
      ['喜欢猫', '我不喜欢猫'],
      ['吃辣', '她不吃辣'],
    ] as const;

    for (const [index, [oldText, incoming]] of cases.entries()) {
      const store = makeStore();
      const sessionKey = `cli:inherit${index}`;
      const old = store.upsert(sessionKey, oldText, 'preference')!.record;

      expect(store.autoReview(sessionKey, incoming)).toBe(0);
      store.upsert(sessionKey, incoming, 'preference');
      const after = store.listLive(sessionKey).find((fact) => fact.id === old.id)!;
      expect(after.baseWeight).toBe(2.5);
      expect(after.conflictedAt).toBeUndefined();
      expect(after.reviews).toBe(0);
    }
  });

  it('多分句继承主语后，同主体反义仍能降权', () => {
    const cases = [
      ['他不在北京但怕猫', '他不怕猫'],
      ['他不在北京但现在喜欢猫', '他现在不喜欢猫'],
      ['他不在北京但一直喜欢猫', '他一直不喜欢猫'],
    ] as const;

    for (const [index, [oldText, incoming]] of cases.entries()) {
      const store = makeStore();
      const sessionKey = `cli:inherit-conflict${index}`;
      const old = store.upsert(sessionKey, oldText, 'preference')!.record;

      expect(store.autoReview(sessionKey, incoming)).toBe(0);
      store.upsert(sessionKey, incoming, 'preference');
      const after = store.listLive(sessionKey).find((fact) => fact.id === old.id)!;
      expect(after.baseWeight).toBeCloseTo(1.25, 6);
      expect(after.conflictedAt).toBeTruthy();
    }
  });

  it('同义否定表达不视为冲突', () => {
    const store = makeStore();
    const old = store.upsert('cli:synonym', '我不喜欢猫', 'preference')!.record;

    expect(store.autoReview('cli:synonym', '我讨厌猫')).toBe(0);
    store.upsert('cli:synonym', '我讨厌猫', 'preference');
    const after = store.listLive('cli:synonym').find((fact) => fact.id === old.id)!;
    expect(after.baseWeight).toBe(2.5);
    expect(after.conflictedAt).toBeUndefined();
  });

  it('同极性分句提到旧事实、另一分句否定旧事实时仍判冲突', () => {
    const store = makeStore();
    const old = store.upsert('cli:dog', '我喜欢狗', 'preference')!.record;

    expect(store.autoReview('cli:dog', '我喜欢猫而不喜欢狗')).toBe(0);
    store.upsert('cli:dog', '我喜欢猫而不喜欢狗', 'preference');
    const after = store.listLive('cli:dog').find((fact) => fact.id === old.id)!;
    expect(after.baseWeight).toBeCloseTo(1.25, 6);
    expect(after.conflictedAt).toBeTruthy();
  });

  it('正常再提及仍复习，并提高注入排序', () => {
    const store = makeStore();
    store.upsert('cli:test', '他不吃香菜', 'preference');
    clock += 1_000;
    store.upsert('cli:test', '他养了一只猫', 'preference');
    clock += 1_000;

    expect(store.autoReview('cli:test', '他也不吃香菜啊')).toBe(1);
    const lines = store.selectForInjection('cli:test').split('\n');
    expect(lines[1]).toContain('他不吃香菜');
    expect(lines[2]).toContain('他养了一只猫');
  });
});
