import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PERSONA_CARD_NICKNAME_LIMIT,
  PERSONA_CARD_TEXT_LIMIT,
  PersonaCardStore,
} from '../../src/agent/persona-card.ts';
import { FactsStore } from '../../src/memory/facts.ts';
import { BigramRetriever } from '../../src/memory/retriever/bigram.ts';
import { SelfNoteStore } from '../../src/memory/selfnote.ts';
import { EventStore } from '../../src/memory/store.ts';
import {
  parseQqMemoryCommand,
  runQqMemoryCommand,
  type QqMemoryCommandOptions,
} from '../../src/qq/memory-commands.ts';
import { normalizeCommandPrefix } from '../../src/util/string.ts';

let dir: string;
const NOW = 1_700_000_000_000;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'xds-memory-commands-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function dependencies() {
  const store = new EventStore({ dir: join(dir, 'events'), now: () => NOW });
  const facts = new FactsStore({
    dir: join(dir, 'facts'),
    halfLifeDays: 45,
    archiveThreshold: 1,
    injectMax: 30,
    injectMaxChars: 900,
    now: () => NOW,
  });
  const selfNotes = new SelfNoteStore({
    dir: join(dir, 'selfnotes'),
    max: 40,
    bootstrapLimit: 20,
    now: () => NOW,
  });
  const personaCard = new PersonaCardStore({
    dir: join(dir, 'persona'),
    onWarn: () => {},
  });
  const retriever = new BigramRetriever({ store, now: () => NOW, ownerQQ: 10001 });
  return { store, facts, selfNotes, personaCard, retriever };
}

function command(
  text: string,
  deps = dependencies(),
  overrides: Partial<QqMemoryCommandOptions> = {},
) {
  return runQqMemoryCommand(text, {
    sessionKey: 'private:10001',
    facts: deps.facts,
    selfNotes: deps.selfNotes,
    personaCard: deps.personaCard,
    retriever: deps.retriever,
    recallBudgetItems: 5,
    ...overrides,
  });
}

describe('QQ memory commands', () => {
  it('只识别明确的命令，未知感叹号文本交回模型', () => {
    expect(parseQqMemoryCommand('!记 他不吃香菜')).toEqual({
      kind: '记',
      body: '他不吃香菜',
    });
    expect(parseQqMemoryCommand('!note 我该更简短')).toEqual({
      kind: 'note',
      body: '我该更简短',
    });
    expect(parseQqMemoryCommand('!回忆 4090')).toEqual({ kind: '回忆', body: '4090' });
    expect(parseQqMemoryCommand('!整理')).toEqual({ kind: '整理', body: '' });
    expect(parseQqMemoryCommand('!称呼 大肥鱼')).toEqual({
      kind: '称呼',
      body: '大肥鱼',
    });
    expect(parseQqMemoryCommand('!人格')).toEqual({ kind: '人格', body: '' });
    expect(parseQqMemoryCommand('!人格 说话简短')).toEqual({
      kind: '人格',
      body: '说话简短',
    });
    expect(parseQqMemoryCommand('!人格 清空')).toEqual({
      kind: '人格',
      body: '清空',
    });
    expect(parseQqMemoryCommand('!忘 4090')).toEqual({ kind: '忘', body: '4090' });
    expect(normalizeCommandPrefix('！整理')).toBe('!整理');
    expect(normalizeCommandPrefix('正常聊天')).toBe('正常聊天');
    expect(parseQqMemoryCommand('！整理')).toEqual({ kind: '整理', body: '' });
    expect(parseQqMemoryCommand('！记 他不吃香菜')).toEqual({
      kind: '记',
      body: '他不吃香菜',
    });
    expect(parseQqMemoryCommand('！note 我该更简短')).toEqual({
      kind: 'note',
      body: '我该更简短',
    });
    expect(parseQqMemoryCommand('！回忆 4090')).toEqual({ kind: '回忆', body: '4090' });
    expect(parseQqMemoryCommand('！称呼 大肥鱼')).toEqual({
      kind: '称呼',
      body: '大肥鱼',
    });
    expect(parseQqMemoryCommand('！人格 说话简短')).toEqual({
      kind: '人格',
      body: '说话简短',
    });
    expect(parseQqMemoryCommand('！忘 4090')).toEqual({ kind: '忘', body: '4090' });
    expect(parseQqMemoryCommand('!记得看看这个')).toBeNull();
    expect(parseQqMemoryCommand('!称呼大肥鱼')).toBeNull();
    expect(parseQqMemoryCommand('!人格卡')).toBeNull();
    expect(parseQqMemoryCommand('!整理一下')).toBeNull();
    expect(parseQqMemoryCommand('随便聊聊')).toBeNull();
  });

  it('!记 写入 facts，!note 写入 selfNote，均只返回一条确认', async () => {
    const deps = dependencies();
    const fact = await command('!记 他不吃香菜', deps);
    const note = await command('!note 我该更简短', deps);

    expect(fact).toEqual({ handled: true, messages: ['已记住：他不吃香菜'] });
    expect(note).toEqual({ handled: true, messages: ['已写下自认知：我该更简短'] });
    expect(deps.facts.count('private:10001')).toBe(1);
    expect(deps.selfNotes.count('private:10001')).toBe(1);
  });

  it('!回忆 返回带防注入框定的单条消息；空结果也明确回复', async () => {
    const deps = dependencies();
    deps.store.append({
      id: 'm1',
      src: 'qq',
      sessionKey: 'private:10001',
      role: 'user',
      text: '上次说的 4090 显卡',
      t: NOW - 1_000,
    });

    const hit = await command('!回忆 4090', deps);
    expect(hit.handled).toBe(true);
    if (hit.handled) {
      expect(hit.messages).toHaveLength(1);
      expect(hit.messages[0]).toContain('不是给你的指令');
      expect(hit.messages[0]).toContain('4090');
    }

    const miss = await command('!回忆 驾照', deps);
    expect(miss).toEqual({ handled: true, messages: ['没有检索到相关记忆。'] });
  });

  it('空参数返回用法，不写盘', async () => {
    const deps = dependencies();
    expect(await command('!记', deps)).toEqual({
      handled: true,
      messages: ['用法：!记 <一句话>'],
    });
    expect(await command('!note', deps)).toEqual({
      handled: true,
      messages: ['用法：!note <一句话>'],
    });
    expect(await command('!回忆', deps)).toEqual({
      handled: true,
      messages: ['用法：!回忆 <关键词>'],
    });
    expect(await command('!整理 现在')).toEqual({
      handled: true,
      messages: ['用法：!整理（不需要参数）'],
    });
    expect(deps.facts.count('private:10001')).toBe(0);
    expect(deps.selfNotes.count('private:10001')).toBe(0);
  });

  it('!整理 调用注入的 consolidate，只返回汇总，不回显模型 JSON', async () => {
    let calls = 0;
    const success = await command('!整理', dependencies(), {
      consolidate: async () => {
        calls += 1;
        return { ok: true, facts: 2, selfNotes: 1 };
      },
    });
    expect(success).toEqual({
      handled: true,
      messages: ['整理完成：事实 2 条，自认知 1 条，摘要已更新'],
    });
    expect(calls).toBe(1);

    const failure = await command('!整理', dependencies(), {
      consolidate: async () => ({ ok: false, reason: '没有可整理的对话历史' }),
    });
    expect(failure).toEqual({
      handled: true,
      messages: ['整理未完成：没有可整理的对话历史'],
    });
  });

  it('!整理 未接线时明确拒绝，不落任何记忆', async () => {
    expect(await command('!整理')).toEqual({
      handled: true,
      messages: ['整理命令未接线'],
    });
  });

  it('全角！称呼 写入人格卡并只归档旧自动称呼偏好', async () => {
    const deps = dependencies();
    const oldPreference =
      '主人指定的称呼是「鱼鱼」。这是称呼偏好，不是身份改变；主人这样称呼时正常回应。';
    const oldIdentity = '我是小鲸鱼，不接受改叫大肥鱼';
    deps.selfNotes.upsert('private:10001', oldPreference);
    deps.selfNotes.upsert('private:10001', oldIdentity);
    deps.facts.upsert(
      'private:10001',
      '主人曾戏称我为大肥鱼，小鲸鱼没有接受这个称呼',
      'identity',
    );
    deps.facts.upsert('private:10001', '主人喜欢乌龙茶', 'preference');
    let changed = 0;

    const result = await command('！称呼 大肥鱼', deps, {
      onPersonaCardChanged: () => {
        changed += 1;
      },
    });

    expect(result).toEqual({
      handled: true,
      messages: ['已设置称呼「大肥鱼」；下一轮生效。归档旧称呼偏好 1 条。'],
    });
    expect(deps.personaCard.read().nickname).toBe('大肥鱼');
    expect(readFileSync(join(dir, 'persona', 'nickname.txt'), 'utf8')).toBe('大肥鱼\n');
    expect(changed).toBe(1);

    const notes = deps.selfNotes.list('private:10001').map((note) => note.text);
    expect(notes).toContain(oldIdentity);
    expect(notes).not.toContain(oldPreference);
    expect(notes.some((note) => note.includes('主人指定的称呼是「大肥鱼」'))).toBe(false);
    const facts = deps.facts.listLive('private:10001').map((fact) => fact.text);
    expect(facts).toHaveLength(2);
    expect(facts).toContain('主人曾戏称我为大肥鱼，小鲸鱼没有接受这个称呼');
    expect(facts).toContain('主人喜欢乌龙茶');

    const noteFile = readFileSync(join(dir, 'selfnotes', 'private_10001.jsonl'), 'utf8');
    expect(noteFile).toContain(oldPreference);
    expect(noteFile).toContain('"archived":true');
    const factFile = readFileSync(join(dir, 'facts', 'private_10001.jsonl'), 'utf8');
    expect(factFile).not.toContain('"archived":true');
  });

  it('!称呼 不按自然语言猜测归档身份类或普通事实', async () => {
    const deps = dependencies();
    const identity = '我是小鲸鱼，身份由我自己确定，不接受被改叫大肥鱼或小黑鲸。';
    deps.selfNotes.upsert('private:10001', identity);
    const factsToKeep = [
      '主人让我记住：项目代号是大肥鱼',
      '助手不接受把项目改叫大肥鱼',
      '我同事没有接受这个称呼',
      '用户问：助手不接受这个称呼的原因',
      '主人说，小鲸鱼不接受这个称呼',
      '助手不接受这种叫法在项目中的命名方式',
      '我坚持自己是AI工程师',
      '主人喜欢乌龙茶',
    ];
    for (const text of factsToKeep) {
      deps.facts.upsert('private:10001', text, 'preference');
    }

    const result = await command('!称呼 大肥鱼', deps);

    expect(result).toEqual({
      handled: true,
      messages: ['已设置称呼「大肥鱼」；下一轮生效。归档旧称呼偏好 0 条。'],
    });
    expect(deps.selfNotes.list('private:10001').map((note) => note.text)).toContain(identity);
    const facts = deps.facts.listLive('private:10001').map((fact) => fact.text);
    expect(facts).toHaveLength(factsToKeep.length);
    for (const text of factsToKeep) expect(facts).toContain(text);
  });

  it('!称呼 后可用 !忘 显式归档旧身份记忆', async () => {
    const deps = dependencies();
    deps.selfNotes.upsert('private:10001', '我是小鲸鱼，不接受改叫大肥鱼');
    deps.facts.upsert('private:10001', '小鲸鱼坚持自己的身份是小鲸鱼', 'identity');

    expect(await command('!称呼 大肥鱼', deps)).toEqual({
      handled: true,
      messages: ['已设置称呼「大肥鱼」；下一轮生效。归档旧称呼偏好 0 条。'],
    });
    expect(
      await command('!忘 小鲸鱼', deps),
    ).toEqual({
      handled: true,
      messages: [
        '已忘掉相关记忆：事实 1 条，自认知 1 条（只归档未删除，原文仍在磁盘）。',
      ],
    });
    expect(deps.selfNotes.list('private:10001').map((note) => note.text)).not.toContain(
      '我是小鲸鱼，不接受改叫大肥鱼',
    );
    expect(deps.facts.listLive('private:10001')).toEqual([]);
    expect(
      readFileSync(join(dir, 'selfnotes', 'private_10001.jsonl'), 'utf8'),
    ).toContain('"archived":true');
    expect(readFileSync(join(dir, 'facts', 'private_10001.jsonl'), 'utf8')).toContain(
      '"archived":true',
    );
  });

  it('!称呼 主人 不按新称呼子串归档普通“主人…”事实', async () => {
    const deps = dependencies();
    deps.selfNotes.upsert('private:10001', '主人不接受香菜');
    deps.facts.upsert('private:10001', '主人喜欢乌龙茶', 'preference');
    deps.facts.upsert('private:10001', '主人不接受香菜', 'preference');

    const result = await command('!称呼 主人', deps);

    expect(result).toEqual({
      handled: true,
      messages: ['已设置称呼「主人」；下一轮生效。归档旧称呼偏好 0 条。'],
    });
    expect(deps.selfNotes.list('private:10001').map((note) => note.text)).toContain(
      '主人不接受香菜',
    );
    const facts = deps.facts.listLive('private:10001').map((fact) => fact.text);
    expect(facts).toHaveLength(2);
    expect(facts).toContain('主人喜欢乌龙茶');
    expect(facts).toContain('主人不接受香菜');
  });

  it('!称呼 空参数与超长参数都明确报错且不写盘', async () => {
    const deps = dependencies();
    expect(await command('!称呼', deps)).toEqual({
      handled: true,
      messages: ['用法：!称呼 <称呼>'],
    });

    const tooLong = '鲸'.repeat(PERSONA_CARD_NICKNAME_LIMIT + 1);
    expect(await command(`!称呼 ${tooLong}`, deps)).toEqual({
      handled: true,
      messages: [
        `称呼过长：最多 ${PERSONA_CARD_NICKNAME_LIMIT} 字（当前 ${
          PERSONA_CARD_NICKNAME_LIMIT + 1
        } 字）`,
      ],
    });
    expect(deps.personaCard.read()).toEqual({ nickname: '', text: '' });
    expect(deps.selfNotes.count('private:10001')).toBe(0);
    expect(deps.facts.count('private:10001')).toBe(0);
  });

  it('!称呼 写盘失败时不归档，返回明确失败', async () => {
    const deps = dependencies();
    let setCalls = 0;
    let noteArchiveCalls = 0;
    let factArchiveCalls = 0;
    let changed = 0;

    const result = await command('!称呼 大肥鱼', deps, {
      personaCard: {
        read: () => ({ nickname: '', text: '' }),
        setNickname: () => {
          setCalls += 1;
          return {
            ok: false,
            error: 'io',
            reason: '写入磁盘失败',
            length: 3,
          };
        },
        setText: () => {
          throw new Error('不应调用 setText');
        },
        clearText: () => {
          throw new Error('不应调用 clearText');
        },
      },
      selfNotes: {
        upsert: () => null,
        archiveMatching: () => {
          noteArchiveCalls += 1;
          return 0;
        },
      },
      facts: {
        upsert: (sessionKey, text, tag) => deps.facts.upsert(sessionKey, text, tag),
        archiveMatching: () => {
          factArchiveCalls += 1;
          return 0;
        },
      },
      onPersonaCardChanged: () => {
        changed += 1;
      },
    });

    expect(result).toEqual({
      handled: true,
      messages: ['称呼写入失败（人格卡未更新）：写入磁盘失败'],
    });
    expect(setCalls).toBe(1);
    expect(noteArchiveCalls).toBe(0);
    expect(factArchiveCalls).toBe(0);
    expect(changed).toBe(0);
    expect(deps.selfNotes.count('private:10001')).toBe(0);
    expect(deps.facts.count('private:10001')).toBe(0);
  });

  it('!人格 空卡时给用法，不写 selfNote/facts', async () => {
    const deps = dependencies();

    expect(await command('!人格', deps)).toEqual({
      handled: true,
      messages: ['用法：!人格（查看）/ !人格 <文本> / !人格 清空'],
    });
    expect(deps.selfNotes.count('private:10001')).toBe(0);
    expect(deps.facts.count('private:10001')).toBe(0);
  });

  it('!人格 设置、查看、清空正文并保留昵称，成功后触发刷新回调', async () => {
    const deps = dependencies();
    let changed = 0;
    const onPersonaCardChanged = (): void => {
      changed += 1;
    };

    expect(await command('!称呼 大肥鱼', deps, { onPersonaCardChanged })).toMatchObject({
      handled: true,
    });
    expect(
      await command('!人格 说话简短', deps, { onPersonaCardChanged }),
    ).toEqual({
      handled: true,
      messages: ['人格卡已更新（4 字）；下一轮生效。'],
    });
    expect(deps.personaCard.read()).toEqual({
      nickname: '大肥鱼',
      text: '说话简短',
    });

    expect(await command('!人格', deps)).toEqual({
      handled: true,
      messages: [
        ['当前人格卡：', '称呼：大肥鱼', '卡片：', '说话简短'].join('\n'),
      ],
    });

    expect(
      await command('!人格 清空', deps, { onPersonaCardChanged }),
    ).toEqual({
      handled: true,
      messages: ['人格卡已清空（称呼保留）；下一轮生效。'],
    });
    expect(deps.personaCard.read()).toEqual({ nickname: '大肥鱼', text: '' });
    expect(await command('!人格', deps)).toEqual({
      handled: true,
      messages: [
        ['当前人格卡：', '称呼：大肥鱼', '卡片：', '（空）'].join('\n'),
      ],
    });

    expect(changed).toBe(3);
    expect(deps.selfNotes.count('private:10001')).toBe(0);
    expect(deps.facts.count('private:10001')).toBe(0);
  });

  it('!人格 超过 2000 字明确报错，已有卡片不被覆盖', async () => {
    const deps = dependencies();
    deps.personaCard.setText('原有卡片');
    const tooLong = '字'.repeat(PERSONA_CARD_TEXT_LIMIT + 1);

    expect(await command(`!人格 ${tooLong}`, deps)).toEqual({
      handled: true,
      messages: [
        `人格卡过长：最多 ${PERSONA_CARD_TEXT_LIMIT} 字（当前 ${
          PERSONA_CARD_TEXT_LIMIT + 1
        } 字）`,
      ],
    });
    expect(deps.personaCard.read().text).toBe('原有卡片');
  });

  it('!人格 写入失败时明确报错，不触发刷新回调', async () => {
    const deps = dependencies();
    let changed = 0;

    const result = await command('!人格 新卡片', deps, {
      personaCard: {
        read: () => ({ nickname: '', text: '' }),
        setNickname: () => {
          throw new Error('不应调用 setNickname');
        },
        setText: () => ({
          ok: false,
          error: 'io',
          reason: '写入磁盘失败',
          length: 3,
        }),
        clearText: () => {
          throw new Error('不应调用 clearText');
        },
      },
      onPersonaCardChanged: () => {
        changed += 1;
      },
    });

    expect(result).toEqual({
      handled: true,
      messages: ['人格卡写入失败（未更新）：写入磁盘失败'],
    });
    expect(changed).toBe(0);
  });

  it('全角！忘 归档两类匹配文本，只归档不删除', async () => {
    const deps = dependencies();
    deps.facts.upsert('private:10001', '4090 显卡驱动要固定版本', 'misc');
    deps.facts.upsert('private:10001', '主人喜欢乌龙茶', 'preference');
    deps.selfNotes.upsert('private:10001', '4090 的驱动不能乱升级');
    deps.selfNotes.upsert('private:10001', '我说话要更简短');

    const result = await command('！忘 4090', deps);

    expect(result).toEqual({
      handled: true,
      messages: [
        '已忘掉相关记忆：事实 1 条，自认知 1 条（只归档未删除，原文仍在磁盘）。',
      ],
    });
    expect(deps.facts.listLive('private:10001').map((fact) => fact.text)).toEqual([
      '主人喜欢乌龙茶',
    ]);
    expect(deps.selfNotes.list('private:10001').map((note) => note.text)).toEqual([
      '我说话要更简短',
    ]);

    const factFile = readFileSync(join(dir, 'facts', 'private_10001.jsonl'), 'utf8');
    expect(factFile).toContain('4090 显卡驱动要固定版本');
    expect(factFile).toContain('"archived":true');
    const noteFile = readFileSync(join(dir, 'selfnotes', 'private_10001.jsonl'), 'utf8');
    expect(noteFile).toContain('4090 的驱动不能乱升级');
    expect(noteFile).toContain('"archived":true');
  });

  it('!忘 空参数返回用法；未知命令仍交回模型', async () => {
    const deps = dependencies();
    expect(await command('!忘', deps)).toEqual({
      handled: true,
      messages: ['用法：!忘 <关键词>'],
    });
    expect(await command('!未知 内容', deps)).toEqual({ handled: false });
  });
});
