import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CodeTaskStore,
  codeTasksStatePath,
  type CodeTaskRecord,
} from '../../src/code-tasks/store.ts';

const NOW = 1_750_000_200_000;

function record(overrides: Partial<CodeTaskRecord> = {}): CodeTaskRecord {
  return {
    requestId: 'evt:1',
    taskId: 'task-1',
    repo: 'ds-memory',
    status: 'queued',
    taskLength: 9,
    submittedAt: NOW,
    updatedAt: NOW,
    startedAt: null,
    finishedAt: null,
    worktree: null,
    changedFiles: [],
    diffStat: null,
    summary: null,
    error: null,
    cancelRequestedAt: null,
    notificationStatus: 'pending',
    notifiedAt: null,
    ...overrides,
  };
}

let stateDir: string;
let warnings: string[];

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'xds-code-store-'));
  warnings = [];
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

function store(): CodeTaskStore {
  return new CodeTaskStore({
    stateDir,
    onWarn: (message) => warnings.push(message),
  });
}

describe('CodeTaskStore', () => {
  it('原子写 v1 文件，重新加载保留字段且无临时文件残留', () => {
    const first = store();
    first.upsert(record({ summary: '完成', changedFiles: ['src/a.ts'] }));

    const path = codeTasksStatePath(stateDir);
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      v: number;
      tasks: CodeTaskRecord[];
    };
    expect(parsed.v).toBe(1);
    expect(parsed.tasks).toEqual([
      expect.objectContaining({
        requestId: 'evt:1',
        taskId: 'task-1',
        repo: 'ds-memory',
        summary: '完成',
        changedFiles: ['src/a.ts'],
        notificationStatus: 'pending',
      }),
    ]);
    expect(readdirSync(stateDir).filter((name) => name.endsWith('.tmp'))).toEqual([]);

    const second = store();
    expect(second.findByRequestId('evt:1')).toEqual(parsed.tasks[0]);
    expect(second.findByTaskId('task-1')).toEqual(parsed.tasks[0]);
  });

  it('requestId/taskId 唯一，更新同一条允许，交叉冲突拒绝', () => {
    const tasks = store();
    tasks.upsert(record());
    tasks.upsert(record({ status: 'running', updatedAt: NOW + 1 }));
    expect(tasks.findByRequestId('evt:1')?.status).toBe('running');

    expect(() => tasks.upsert(record({ taskId: 'task-2' }))).toThrow(
      'requestId 冲突',
    );
    expect(() =>
      tasks.upsert(record({ requestId: 'evt:2', taskId: 'task-1' })),
    ).toThrow('taskId 冲突');
  });

  it('损坏状态文件告警并按空状态继续', () => {
    writeFileSync(codeTasksStatePath(stateDir), '{broken', 'utf8');

    const tasks = store();
    expect(tasks.list()).toEqual([]);
    expect(warnings).toEqual(['code-tasks 状态读取失败，按空状态继续']);
  });

  it('持久化失败时回滚内存状态', () => {
    const blockedStateDir = join(stateDir, 'blocked');
    writeFileSync(blockedStateDir, 'not a directory', 'utf8');
    const tasks = new CodeTaskStore({
      stateDir: blockedStateDir,
      onWarn: (message) => warnings.push(message),
    });

    expect(() => tasks.upsert(record())).toThrow('code-tasks 状态写入失败');
    expect(tasks.list()).toEqual([]);
  });

  it('旧 v1 记录缺少 sessionId/workspace/mode 时仍可读取', () => {
    const legacy = record();
    writeFileSync(
      codeTasksStatePath(stateDir),
      JSON.stringify({ v: 1, tasks: [legacy] }),
      'utf8',
    );

    const tasks = store();
    expect(tasks.findByRequestId('evt:1')).toEqual(legacy);
    expect(warnings).toEqual([]);
  });

  it('接受 dsh-session 与可选会话字段，并能原子往返', () => {
    const tasks = store();
    tasks.upsert(
      record({
        requestId: 'evt:resume',
        taskId: 'task-resume',
        repo: 'dsh-session',
        sessionId: 'sess-12345678',
        workspace: 'C:\\work\\ds-memory',
        mode: 'resume',
      }),
    );
    tasks.upsert(
      record({
        requestId: 'evt:workspace',
        taskId: 'task-workspace',
        sessionId: null,
        workspace: null,
        mode: 'workspace',
      }),
    );
    tasks.upsert(
      record({
        requestId: 'evt:null-mode',
        taskId: 'task-null-mode',
        repo: 'dsh-session',
        sessionId: null,
        workspace: null,
        mode: null,
      }),
    );

    const reloaded = store();
    expect(reloaded.findByTaskId('task-resume')).toMatchObject({
      repo: 'dsh-session',
      sessionId: 'sess-12345678',
      workspace: 'C:\\work\\ds-memory',
      mode: 'resume',
    });
    expect(reloaded.findByTaskId('task-workspace')).toMatchObject({
      sessionId: null,
      workspace: null,
      mode: 'workspace',
    });
    expect(reloaded.findByTaskId('task-null-mode')).toMatchObject({
      repo: 'dsh-session',
      sessionId: null,
      workspace: null,
      mode: null,
    });
  });

  it('接受 martilyric repo 并能原子往返', () => {
    const tasks = store();
    tasks.upsert(
      record({
        requestId: 'evt:martilyric',
        taskId: 'task-martilyric',
        repo: 'martilyric',
      }),
    );

    expect(store().findByTaskId('task-martilyric')).toMatchObject({
      repo: 'martilyric',
    });
  });

  it('新字段非法时只丢弃该条并告警，其余记录保留', () => {
    const valid = record();
    writeFileSync(
      codeTasksStatePath(stateDir),
      JSON.stringify({
        v: 1,
        tasks: [
          valid,
          {
            ...record({ requestId: 'evt:bad-session', taskId: 'task-bad-session' }),
            sessionId: 'bad session id',
          },
          {
            ...record({ requestId: 'evt:bad-workspace', taskId: 'task-bad-workspace' }),
            workspace: 'x'.repeat(501),
          },
          {
            ...record({ requestId: 'evt:bad-mode', taskId: 'task-bad-mode' }),
            mode: 'other',
          },
          {
            ...record({
              requestId: 'evt:mode-mismatch',
              taskId: 'task-mode-mismatch',
            }),
            mode: 'resume',
          },
        ],
      }),
      'utf8',
    );

    const tasks = store();
    expect(tasks.list()).toEqual([valid]);
    expect(warnings).toEqual(['code-tasks 状态含无效或重复记录，已跳过']);
  });
});
