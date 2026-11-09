import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LIBRARY_CONTENT_FRAME,
  LIBRARY_MAX_FILE_BYTES,
  LIBRARY_MAX_TAGS,
  LIBRARY_SNIPPET_LIMIT,
  LIBRARY_TAG_LIMIT,
  LIBRARY_TEXT_LIMIT,
  LIBRARY_TITLE_LIMIT,
  LibraryStore,
  LibraryStoreError,
  type LibraryStoreErrorCode,
} from '../../src/memory/library.ts';
import { createAgentMemoryToolRuntime } from '../../src/tools/memory/index.ts';

let rootDir: string;
let libraryDir: string;
let library: LibraryStore;
let clock: number;

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'xds-library-'));
  libraryDir = join(rootDir, 'library');
  clock = new Date(2026, 10, 8, 9, 7, 5).getTime();
  library = new LibraryStore({
    dir: libraryDir,
    now: () => clock,
    onWarn: () => undefined,
  });
});

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

function frontmatterOf(raw: string): { fields: string; body: string } {
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(raw);
  expect(match).not.toBeNull();
  return {
    fields: match![1]!,
    body: raw.slice(match![0].length),
  };
}

function frontmatterValue(fields: string, key: string): unknown {
  const match = new RegExp(`^${key}[ \\t]*:[ \\t]*(.+?)[ \\t]*$`, 'm').exec(fields);
  expect(match).not.toBeNull();
  return JSON.parse(match![1]!);
}

function writeDoc(name: string, content: string): void {
  mkdirSync(libraryDir, { recursive: true });
  writeFileSync(join(libraryDir, name), content, 'utf8');
}

function expectLibraryError(fn: () => unknown, code: LibraryStoreErrorCode): void {
  try {
    fn();
    throw new Error('应当抛出资资料库错误');
  } catch (error) {
    expect(error).toBeInstanceOf(LibraryStoreError);
    expect((error as LibraryStoreError).code).toBe(code);
  }
}

describe('LibraryStore', () => {
  it('工具写入生成 md、frontmatter 可解析，并可检索和读取正文', async () => {
    const runtime = createAgentMemoryToolRuntime({
      ownerSessionKey: 'private:123456789',
      facts: { upsert: () => null } as never,
      selfNotes: { upsert: () => null } as never,
      library,
    });
    const titleInput = '  API 路线 / 记录  ';
    const textInput = '资料正文：先做 API 路线检索，再读取全文。';
    const tags = ['项目', 'api'];
    const result = await runtime.execute({
      id: 'write-library',
      name: 'library_write',
      argumentsText: JSON.stringify({ title: titleInput, text: textInput, tags }),
    });

    expect(result.error).toBeUndefined();
    expect(result.content.startsWith(LIBRARY_CONTENT_FRAME)).toBe(true);
    const id = /已保存资料：([^（]+)（/.exec(result.content)?.[1];
    expect(id).toBeTruthy();
    expect(id).toMatch(/^\d{8}-\d{6}-.+-[0-9a-f]{8}\.md$/u);

    const slug = /^\d{8}-\d{6}-(.+)-[0-9a-f]{8}\.md$/u.exec(id!)?.[1]!;
    expect(slug).toMatch(/^[\p{L}\p{N}-]+$/u);
    expect(Array.from(slug).length).toBeLessThanOrEqual(40);
    expect(slug.includes('/')).toBe(false);

    const raw = readFileSync(join(libraryDir, id!), 'utf8');
    const { fields, body } = frontmatterOf(raw);
    expect(frontmatterValue(fields, 'title')).toBe('API 路线 / 记录');
    expect(frontmatterValue(fields, 'created')).toBe(new Date(clock).toISOString());
    expect(frontmatterValue(fields, 'source')).toBe('owner');
    expect(frontmatterValue(fields, 'tags')).toEqual(tags);
    expect(body).toBe(textInput);

    const hits = library.search('API 路线');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      id,
      title: 'API 路线 / 记录',
      score: 1,
    });
    expect(library.read(id!).text).toBe(textInput);
  });

  it('人工投放无 frontmatter 的 md/txt 可索引，标题回退一级标题或文件名', () => {
    writeDoc('heading.md', '# 手冲咖啡指南\n\n水温 92 度。');
    writeDoc('plain.txt', '随手记：豆子要新鲜。');
    writeDoc(
      'frontmatter.md',
      '---\ntitle: "手工标题"\ncreated: "2026-01-02T03:04:05.000Z"\n---\n# 一级标题\n正文关键词：磨豆机。',
    );

    expect(library.read('heading.md').title).toBe('手冲咖啡指南');
    expect(library.read('plain.txt').title).toBe('plain');
    expect(library.read('frontmatter.md').title).toBe('手工标题');
    expect(library.read('frontmatter.md').createdAt).toBe('2026-01-02T03:04:05.000Z');

    expect(library.search('手冲咖啡')[0]?.id).toBe('heading.md');
    expect(library.search('豆子')[0]?.id).toBe('plain.txt');
    expect(library.search('手工标题')[0]?.snippet).toContain('手工标题');
    expect(library.stats().count).toBe(3);
  });

  it('超过 512 KiB、隐藏文件和子目录不进入索引', () => {
    writeDoc('visible.md', '# 可见\n\n正常资料。');
    writeDoc('large.md', 'a'.repeat(LIBRARY_MAX_FILE_BYTES + 1));
    writeDoc('.hidden.md', '# 隐藏\n\n不应被索引。');
    mkdirSync(join(libraryDir, 'nested'), { recursive: true });
    writeFileSync(join(libraryDir, 'nested', 'child.md'), '# 子目录\n\n不应被索引。', 'utf8');

    const stats = library.stats();
    expect(stats.count).toBe(1);
    expect(library.search('隐藏')).toEqual([]);
    expect(library.search('正常资料')[0]?.id).toBe('visible.md');
  });

  it('symlink 不进入索引，也不能被 read', (ctx) => {
    writeDoc('real.md', '# 真实资料\n\n正文。');
    const linkPath = join(libraryDir, 'link.md');
    try {
      symlinkSync(join(libraryDir, 'real.md'), linkPath, 'file');
    } catch {
      ctx.skip('当前环境不允许创建 symlink');
      return;
    }

    expect(library.stats().count).toBe(1);
    expect(library.search('真实资料').map((hit) => hit.id)).toEqual(['real.md']);
    expectLibraryError(() => library.read('link.md'), 'invalid_id');
  });

  it('search 处理空 query 与 limit 边界，并按覆盖率排序、生成上下文片段', () => {
    writeDoc('a.md', '# 手冲咖啡\n手冲咖啡需要稳定的水温。');
    writeDoc('b.md', '# 咖啡豆\n咖啡豆要新鲜。');
    writeDoc('c.md', '# 其他\n冲咖啡不加糖。');
    writeDoc('d.md', '# 速记\n咖啡豆。');
    const longBody = `${'前'.repeat(260)}目标词${'后'.repeat(260)}`;
    writeDoc('long.md', `# 长文\n${longBody}`);

    expect(library.search('   ')).toEqual([]);
    expect(library.search('咖啡', 5).length).toBe(3);
    expect(library.search('咖啡', 1).length).toBe(1);
    expect(library.search('咖啡', 0).length).toBe(1);
    expect(library.search('咖啡', 99).length).toBe(3);

    const ranked = library.search('手冲咖啡', 5);
    expect(ranked[0]).toMatchObject({ id: 'a.md', score: 1 });
    expect(ranked[1]?.id).toBe('c.md');
    expect(ranked[1]!.score).toBeCloseTo(2 / 3, 4);

    const snippetHit = library.search('目标词', 3)[0]!;
    expect(snippetHit.id).toBe('long.md');
    expect(Array.from(snippetHit.snippet).length).toBeLessThanOrEqual(
      LIBRARY_SNIPPET_LIMIT,
    );
    expect(snippetHit.snippet).toContain('目标词');
    expect(snippetHit.snippet).toContain('前');
    expect(snippetHit.snippet).not.toBe(longBody);
  });

  it('read 拒绝路径穿越、绝对路径、隐藏文件和非 md/txt', () => {
    writeDoc('ok.md', '# 正常\n正文。');
    writeDoc('.hidden.md', '# 隐藏\n正文。');
    writeDoc('note.json', '{}');
    mkdirSync(join(libraryDir, 'folder.md'), { recursive: true });

    expectLibraryError(() => library.read('../outside.md'), 'invalid_id');
    expectLibraryError(() => library.read(join(libraryDir, 'ok.md')), 'invalid_id');
    expectLibraryError(() => library.read('.hidden.md'), 'invalid_id');
    expectLibraryError(() => library.read('note.json'), 'invalid_id');
    expectLibraryError(() => library.read('folder.md'), 'invalid_id');
    writeDoc('oversized.md', 'a'.repeat(LIBRARY_MAX_FILE_BYTES + 1));
    expectLibraryError(() => library.read('oversized.md'), 'read_failed');
    expectLibraryError(() => library.read('missing.md'), 'not_found');
    expect(library.read('ok.md').text).toBe('# 正常\n正文。');
  });

  it('title/text/tags 硬截断，空 title/text 拒绝', () => {
    const tags = [
      '长'.repeat(LIBRARY_TAG_LIMIT + 6),
      ...Array.from({ length: 10 }, (_, index) => `tag-${index}`),
      'tag-0',
    ];
    const result = library.write({
      title: '标题'.repeat(80),
      text: '内容'.repeat(5000),
      tags,
    });

    expect(Array.from(result.title).length).toBe(LIBRARY_TITLE_LIMIT);
    expect(result.tags.length).toBe(LIBRARY_MAX_TAGS);
    expect(result.tags.every((tag) => Array.from(tag).length <= LIBRARY_TAG_LIMIT)).toBe(
      true,
    );
    const raw = readFileSync(join(libraryDir, result.id), 'utf8');
    const { fields, body } = frontmatterOf(raw);
    expect(frontmatterValue(fields, 'title')).toBe(result.title);
    expect(Array.from(body).length).toBe(LIBRARY_TEXT_LIMIT);

    expectLibraryError(() => library.write({ title: '   ', text: '正文' }), 'empty_title');
    expectLibraryError(() => library.write({ title: '标题', text: ' \n ' }), 'empty_text');
  });

  it('stats 统计缓存可失效，写盘失败返回结构化错误', () => {
    writeDoc('a.md', 'aaa');
    writeDoc('b.txt', 'bbbb');
    const first = library.stats();
    expect(first).toEqual({
      count: 2,
      bytes: statSync(join(libraryDir, 'a.md')).size + statSync(join(libraryDir, 'b.txt')).size,
    });

    writeDoc('c.md', 'ccccc');
    const second = library.stats();
    expect(second.count).toBe(3);
    expect(second.bytes).toBe(
      first.bytes + statSync(join(libraryDir, 'c.md')).size,
    );

    const blockedDir = join(rootDir, 'blocked-library');
    writeFileSync(blockedDir, 'not a directory', 'utf8');
    const blocked = new LibraryStore({ dir: blockedDir, onWarn: () => undefined });
    expectLibraryError(
      () => blocked.write({ title: '标题', text: '正文' }),
      'write_failed',
    );
  });
});
