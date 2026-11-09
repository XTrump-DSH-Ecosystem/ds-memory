import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readSessionState, writeSessionState } from '../../src/state/persist.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'xds-persist-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('会话状态持久化', () => {
  it('旧 JSON 只有 summary/lastActiveAt 时可正常读取，新字段保持缺省', () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'cli_owner.json'),
      JSON.stringify({ sessionKey: 'cli:owner', summary: '旧摘要', lastActiveAt: '2026-01-01T00:00:00.000Z' }),
      'utf8',
    );

    const state = readSessionState(dir, 'cli:owner');
    expect(state).toEqual({
      sessionKey: 'cli:owner',
      summary: '旧摘要',
      lastActiveAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('非法 history 项被忽略，合法 user/assistant 原文保留', () => {
    writeFileSync(
      join(dir, 'qq_group_9.json'),
      JSON.stringify({
        sessionKey: 'qq:group:9',
        summary: '',
        lastActiveAt: '2026-01-01T00:00:00.000Z',
        history: [
          { role: 'user', content: '  保留  ' },
          { role: 'system', content: '不应恢复' },
          { role: 'assistant', content: '' },
          { role: 'assistant', content: '回复' },
        ],
        turnsSinceCompaction: 4,
        lastTurnAt: '2026-01-01T00:00:01.000Z',
      }),
      'utf8',
    );

    expect(readSessionState(dir, 'qq:group:9')).toMatchObject({
      history: [
        { role: 'user', content: '  保留  ' },
        { role: 'assistant', content: '回复' },
      ],
      turnsSinceCompaction: 4,
      lastTurnAt: '2026-01-01T00:00:01.000Z',
    });
  });

  it('目标目录不可写时返回 false，不抛出', () => {
    const blocker = join(dir, 'sessions');
    writeFileSync(blocker, 'not a directory', 'utf8');

    expect(
      writeSessionState(blocker, {
        sessionKey: 'cli:owner',
        summary: '摘要',
        lastActiveAt: '2026-01-01T00:00:00.000Z',
      }),
    ).toBe(false);
  });
});
