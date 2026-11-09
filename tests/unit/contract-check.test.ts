import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const scriptPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../scripts/contract-check.mjs',
);

const tempRoots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'xds-contract-check-'));
  tempRoots.push(root);
  return root;
}

function writeFile(root: string, relPath: string, content: string): void {
  const fullPath = join(root, relPath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content, 'utf8');
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function writeManifest(
  root: string,
  entries: Array<{ path: string; content: string }>,
): void {
  const lines = entries.map((entry) => {
    writeFile(root, entry.path, entry.content);
    return `${sha256(entry.content)}  ${entry.path}`;
  });
  writeFile(root, 'tests/contract/manifest.sha256', `${lines.join('\n')}\n`);
}

function runCheck(root: string) {
  return spawnSync(process.execPath, [scriptPath, root], { encoding: 'utf8' });
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('contract:check', () => {
  it('合法 fixtures + manifest 时通过', () => {
    const root = makeRoot();
    writeManifest(root, [
      { path: 'tests/contract/a.json', content: '{"a":1}\n' },
      { path: 'tests/contract/nested/b.json', content: '{"b":2}\n' },
    ]);

    const result = runCheck(root);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('2 file(s) verified');
  });

  it('fixture 内容被篡改时失败', () => {
    const root = makeRoot();
    writeManifest(root, [{ path: 'tests/contract/a.json', content: '{"a":1}\n' }]);
    writeFile(root, 'tests/contract/a.json', '{"a":2}\n');

    const result = runCheck(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('sha256 mismatch');
  });

  it('存在未登记 JSON fixture 时失败', () => {
    const root = makeRoot();
    writeManifest(root, [{ path: 'tests/contract/a.json', content: '{"a":1}\n' }]);
    writeFile(root, 'tests/contract/unlisted.json', '{"b":2}\n');

    const result = runCheck(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unlisted JSON fixture: unlisted.json');
  });

  it('清单出现重复规范化路径时失败', () => {
    const root = makeRoot();
    writeManifest(root, [
      { path: 'tests/contract/a.json', content: '{"a":1}\n' },
      { path: './tests/contract/a.json', content: '{"a":1}\n' },
    ]);

    const result = runCheck(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('duplicate manifest entry');
  });

  it('清单路径逃逸 tests/contract 时失败', () => {
    const root = makeRoot();
    mkdirSync(join(root, 'tests', 'contract'), { recursive: true });
    writeFile(root, 'outside.json', 'outside\n');
    writeFile(
      root,
      'tests/contract/manifest.sha256',
      `${sha256('outside\n')}  ../../outside.json\n`,
    );

    const result = runCheck(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('path escapes tests/contract');
  });
});
