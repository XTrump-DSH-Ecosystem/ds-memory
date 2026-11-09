import {
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentToolRuntime } from '../../src/agent/tool-runtime.ts';
import { FactsStore } from '../../src/memory/facts.ts';
import { LIBRARY_CONTENT_FRAME, LibraryStore } from '../../src/memory/library.ts';
import { SelfNoteStore } from '../../src/memory/selfnote.ts';
import { createAgentMemoryToolRuntime } from '../../src/tools/memory/index.ts';

let rootDir: string;
let facts: FactsStore;
let selfNotes: SelfNoteStore;
let runtime: AgentToolRuntime;

const SESSION = 'private:123456789';

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'xds-memory-tools-'));
  facts = new FactsStore({
    dir: join(rootDir, 'facts'),
    halfLifeDays: 45,
    archiveThreshold: 1,
    injectMax: 10,
    injectMaxChars: 1000,
    autoReviewEnabled: false,
    onWarn: () => undefined,
  });
  selfNotes = new SelfNoteStore({
    dir: join(rootDir, 'selfnotes'),
    max: 40,
    bootstrapLimit: 20,
    onWarn: () => undefined,
  });
  runtime = createAgentMemoryToolRuntime({
    ownerSessionKey: SESSION,
    facts,
    selfNotes,
  });
});

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

function call(args: Record<string, unknown>): Promise<{ content: string; error?: string }> {
  return invoke(runtime, 'memory_write', args);
}

function invoke(
  target: AgentToolRuntime,
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: string; error?: string }> {
  return target.execute({
    id: 'call-memory',
    name,
    argumentsText: JSON.stringify(args),
  });
}

describe('memory_write tool', () => {
  it('只暴露一个 memory_write 工具，并要求 category/text', () => {
    expect(runtime.specs).toHaveLength(1);
    const spec = runtime.specs[0]!;
    expect(spec.name).toBe('memory_write');
    expect(spec.parameters).toMatchObject({
      required: ['category', 'text'],
      additionalProperties: false,
    });
  });

  it('写入 fact，保留 tag 并由代码兜底截断', async () => {
    const longText = '喜欢'.repeat(100);
    const result = await call({
      category: 'fact',
      text: `  ${longText}  `,
      tag: 'preference',
    });

    expect(result.error).toBeUndefined();
    expect(result.content).toContain('已记住');
    const records = facts.listLive(SESSION);
    expect(records).toHaveLength(1);
    expect(records[0]?.tag).toBe('preference');
    // 120 字正文 + 固定截断标记。
    expect(Array.from(records[0]!.text).length).toBeLessThanOrEqual(132);
    expect(records[0]!.text.endsWith('…[truncated]')).toBe(true);
  });

  it('同文本再次写入视为复习，不重复落库', async () => {
    await call({ category: 'fact', text: '主人喜欢美式咖啡' });
    const second = await call({ category: 'fact', text: '主人喜欢美式咖啡' });

    expect(second.content).toContain('复习一次');
    const records = facts.listLive(SESSION);
    expect(records).toHaveLength(1);
    expect(records[0]?.reviews).toBe(1);
  });

  it('写入 selfNote，并按 300 字截断', async () => {
    const result = await call({
      category: 'selfNote',
      text: '我是大肥鱼。'.repeat(80),
    });

    expect(result.error).toBeUndefined();
    expect(result.content).toContain('已写下自认知');
    const notes = selfNotes.list(SESSION);
    expect(notes).toHaveLength(1);
    expect(Array.from(notes[0]!.text).length).toBeLessThanOrEqual(312);
    expect(notes[0]!.text.endsWith('…[truncated]')).toBe(true);
  });

  it('非法参数、空文本、未知 category/tag 均返回结构化错误', async () => {
    for (const args of [
      { category: 'fact', text: '   ' },
      { category: 'unknown', text: '内容' },
      { text: '缺少 category' },
    ]) {
      const result = await call(args);
      expect(result.error).toBeTruthy();
      expect(result.content).toMatch(/^\[memory_tool_error:/);
    }

    const unknownTag = await call({
      category: 'fact',
      text: '未知 tag 应按 misc 处理',
      tag: 'not-a-tag',
    });
    expect(unknownTag.error).toBeUndefined();
    expect(facts.listLive(SESSION)[0]?.tag).toBe('misc');
  });

  it('写盘失败返回固定错误，不抛异常', async () => {
    const failing = createAgentMemoryToolRuntime({
      ownerSessionKey: SESSION,
      facts: { upsert: () => null } as never,
      selfNotes,
    });
    const result = await failing.execute({
      id: 'call-fail',
      name: 'memory_write',
      argumentsText: JSON.stringify({ category: 'fact', text: '会失败' }),
    });

    expect(result.error).toBe('memory_write_failed');
    expect(result.content).toContain('memory_write_failed');
  });

  it('store 抛异常时同样返回固定错误', async () => {
    const throwing = createAgentMemoryToolRuntime({
      ownerSessionKey: SESSION,
      facts: {
        upsert: () => {
          throw new Error('boom');
        },
      } as never,
      selfNotes,
    });
    const result = await throwing.execute({
      id: 'call-throw',
      name: 'memory_write',
      argumentsText: JSON.stringify({ category: 'fact', text: '会抛异常' }),
    });

    expect(result.error).toBe('memory_write_failed');
    expect(result.content).toContain('memory_write_failed');
  });
});

describe('library tools', () => {
  function withLibrary(library: LibraryStore): AgentToolRuntime {
    return createAgentMemoryToolRuntime({
      ownerSessionKey: SESSION,
      facts,
      selfNotes,
      library,
    });
  }

  it('传入 library 时增加三个 spec，参数约束完整', () => {
    const target = withLibrary(
      new LibraryStore({ dir: join(rootDir, 'library-spec'), onWarn: () => undefined }),
    );
    expect(target.specs.map((spec) => spec.name)).toEqual([
      'memory_write',
      'library_write',
      'library_search',
      'library_read',
    ]);

    const write = target.specs.find((spec) => spec.name === 'library_write')!;
    expect(write.parameters).toMatchObject({
      type: 'object',
      required: ['title', 'text'],
      additionalProperties: false,
    });

    const search = target.specs.find((spec) => spec.name === 'library_search')!;
    expect(search.parameters).toMatchObject({
      type: 'object',
      required: ['query'],
      additionalProperties: false,
    });
    expect(search.parameters?.properties).toMatchObject({
      limit: { type: 'integer', minimum: 1, maximum: 5 },
    });

    const read = target.specs.find((spec) => spec.name === 'library_read')!;
    expect(read.parameters).toMatchObject({
      type: 'object',
      required: ['id'],
      additionalProperties: false,
    });
  });

  it('library_write/search/read 正常 dispatch，返回始终带固定框定', async () => {
    const library = new LibraryStore({
      dir: join(rootDir, 'library-dispatch'),
      now: () => 1_800_000_000_000,
      onWarn: () => undefined,
    });
    const target = withLibrary(library);
    const body = `${'资料正文'.repeat(150)}检索锚点`;

    const written = await invoke(target, 'library_write', {
      title: '项目资料',
      text: body,
      tags: ['项目'],
    });
    expect(written.error).toBeUndefined();
    expect(written.content.startsWith(LIBRARY_CONTENT_FRAME)).toBe(true);
    expect(facts.listLive(SESSION)).toHaveLength(0);
    expect(selfNotes.list(SESSION)).toHaveLength(0);

    const [id] = readdirSync(join(rootDir, 'library-dispatch'));
    expect(id).toBeTruthy();

    const searched = await invoke(target, 'library_search', {
      query: '检索锚点',
      limit: 3,
    });
    expect(searched.error).toBeUndefined();
    expect(searched.content.startsWith(LIBRARY_CONTENT_FRAME)).toBe(true);
    expect(searched.content).toContain(`《项目资料》（${id}，`);
    expect(searched.content).toContain('检索锚点');

    const read = await invoke(target, 'library_read', { id: id! });
    expect(read.error).toBeUndefined();
    expect(read.content.startsWith(LIBRARY_CONTENT_FRAME)).toBe(true);
    expect(read.content).toContain(id!);
    expect(read.content).toContain(body);
  });

  it('library 工具错误使用固定格式，不泄露路径、异常栈或正文', async () => {
    const library = new LibraryStore({
      dir: join(rootDir, 'library-errors'),
      onWarn: () => undefined,
    });
    const target = withLibrary(library);

    const emptyTitle = await invoke(target, 'library_write', {
      title: '   ',
      text: '正文',
    });
    expect(emptyTitle.content).toBe(
      '[library_tool_error:empty_title] 资料标题不能为空。',
    );

    const emptyText = await invoke(target, 'library_write', {
      title: '标题',
      text: ' \n ',
    });
    expect(emptyText.content).toBe('[library_tool_error:empty_text] 资料内容不能为空。');

    const badLimit = await invoke(target, 'library_search', {
      query: '资料',
      limit: 0,
    });
    expect(badLimit.content).toMatch(/^\[library_tool_error:invalid_arguments\] /);

    const badId = await invoke(target, 'library_read', { id: '../secret.md' });
    expect(badId.content).toBe('[library_tool_error:invalid_id] 资料 id 不合法。');

    const missing = await invoke(target, 'library_read', { id: 'missing.md' });
    expect(missing.content).toBe('[library_tool_error:not_found] 没有找到这条资料。');

    const failingSearch = createAgentMemoryToolRuntime({
      ownerSessionKey: SESSION,
      facts,
      selfNotes,
      library: {
        write: () => {
          throw new Error('secret write body');
        },
        search: () => {
          throw new Error('secret search body');
        },
        read: () => {
          throw new Error('secret read body');
        },
      },
    });
    const searchFailed = await invoke(failingSearch, 'library_search', {
      query: '资料',
    });
    expect(searchFailed.content).toBe('[library_tool_error:search_failed] 资料检索失败。');
    const readFailed = await invoke(failingSearch, 'library_read', { id: 'ok.md' });
    expect(readFailed.content).toBe('[library_tool_error:read_failed] 资料读取失败。');

    const blockedDir = join(rootDir, 'blocked-library-tools');
    writeFileSync(blockedDir, 'not a directory', 'utf8');
    const blockedRuntime = withLibrary(
      new LibraryStore({ dir: blockedDir, onWarn: () => undefined }),
    );
    const writeFailed = await invoke(blockedRuntime, 'library_write', {
      title: '标题',
      text: '不会写入的正文',
    });
    expect(writeFailed.content).toBe('[library_tool_error:write_failed] 资料写入失败。');
    expect(writeFailed.content).not.toContain(rootDir);
    expect(searchFailed.content).not.toContain('secret');
    expect(readFailed.content).not.toContain('secret');
  });
});
