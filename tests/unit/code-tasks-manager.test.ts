import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CodeBridgeError,
  type CodeBridgeApi,
  type CodeBridgeHealth,
  type CodeBridgeSession,
  type CodeBridgeTask,
  type CodeBridgeTaskInput,
} from '../../src/code-tasks/bridge-client.ts';
import {
  CodeTaskManager,
  type IncomingCodeCommand,
} from '../../src/code-tasks/manager.ts';
import {
  CodeTaskStore,
  codeTasksStatePath,
  type CodeTaskRecord,
} from '../../src/code-tasks/store.ts';
import type {
  QqSendOptions,
  QqSender,
  QqTarget,
  SendResult,
} from '../../src/qq/types.ts';

const NOW = 1_750_000_000_000;
const OWNER_QQ = 123456789;
const OWNER = String(OWNER_QQ);

class FakeBridge implements CodeBridgeApi {
  readonly submitCalls: CodeBridgeTaskInput[] = [];
  readonly getCalls: string[] = [];
  readonly cancelCalls: string[] = [];
  readonly sessionCalls: Array<{ query?: string; limit?: number }> = [];
  submitError: unknown = null;
  cancelError: unknown = null;
  sessionError: unknown = null;
  cancelResult: CodeBridgeTask | null = null;
  queuedTask: CodeBridgeTask | null = null;
  polledTask: CodeBridgeTask | null = null;
  sessions: CodeBridgeSession[] = [];

  async submit(input: CodeBridgeTaskInput): Promise<CodeBridgeTask> {
    this.submitCalls.push({ ...input });
    if (this.submitError) throw this.submitError;
    return this.queuedTask ?? task({ requestId: input.requestId, repo: input.repo });
  }

  async get(taskId: string): Promise<CodeBridgeTask> {
    this.getCalls.push(taskId);
    if (!this.polledTask) throw new Error('missing polledTask');
    return this.polledTask;
  }

  async cancel(taskId: string): Promise<CodeBridgeTask> {
    this.cancelCalls.push(taskId);
    if (this.cancelError) throw this.cancelError;
    return this.cancelResult ?? task({ taskId });
  }

  async listSessions(query?: string, limit?: number): Promise<CodeBridgeSession[]> {
    this.sessionCalls.push({ query, limit });
    if (this.sessionError) throw this.sessionError;
    return this.sessions;
  }

  async health(): Promise<CodeBridgeHealth> {
    return { name: 'code-bridge', ok: true };
  }
}

interface SendCall {
  target: QqTarget;
  messages: string[];
  opts?: QqSendOptions;
}

function senderWith(results: SendResult[]): { sender: QqSender; calls: SendCall[] } {
  const calls: SendCall[] = [];
  return {
    calls,
    sender: {
      async send(target, messages, opts) {
        calls.push({ target, messages: [...messages], opts });
        return results[Math.min(calls.length - 1, results.length - 1)]!;
      },
    },
  };
}

function allSent(): SendResult {
  return {
    outcome: 'all_sent',
    sentIndexes: [0],
    failedIndexes: [],
    retryable: false,
    retryAfterMs: null,
    reason: null,
  };
}

function noneSent(): SendResult {
  return {
    outcome: 'none_sent',
    sentIndexes: [],
    failedIndexes: [0],
    retryable: false,
    retryAfterMs: null,
    reason: 'gateway_offline',
  };
}

function ambiguous(): SendResult {
  return {
    outcome: 'ambiguous_failure',
    sentIndexes: [],
    failedIndexes: [],
    retryable: false,
    retryAfterMs: null,
    reason: 'send_unknown',
  };
}

function task(overrides: Partial<CodeBridgeTask> = {}): CodeBridgeTask {
  return {
    taskId: 'task-1',
    requestId: 'evt:task-1',
    repo: 'ds-memory',
    status: 'queued',
    createdAt: NOW,
    updatedAt: NOW,
    startedAt: null,
    finishedAt: null,
    worktree: null,
    changedFiles: [],
    diffStat: null,
    summary: null,
    error: null,
    cancelRequestedAt: null,
    ...overrides,
  };
}

function session(
  overrides: Partial<CodeBridgeSession> = {},
): CodeBridgeSession {
  return {
    sessionId: 'sess-00000000-0000-4000-8000-000000000001',
    title: '修复工具接线',
    workspace: 'ds-memory',
    lastUsedAt: NOW,
    resumable: true,
    ...overrides,
  };
}

function record(overrides: Partial<CodeTaskRecord> = {}): CodeTaskRecord {
  return {
    requestId: 'evt:record',
    taskId: 'record-task',
    repo: 'xtds',
    status: 'queued',
    taskLength: 12,
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

let rootDir: string;
let stateDir: string;
let warnings: string[];
let managers: CodeTaskManager[];

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'xds-code-manager-'));
  stateDir = join(rootDir, 'state');
  warnings = [];
  managers = [];
});

afterEach(async () => {
  while (managers.length > 0) await managers.pop()!.stop();
  rmSync(rootDir, { recursive: true, force: true });
});

function newStore(): CodeTaskStore {
  return new CodeTaskStore({
    stateDir,
    onWarn: (message) => warnings.push(message),
  });
}

function newManager(
  bridge: CodeBridgeApi,
  sender: QqSender,
  store: CodeTaskStore = newStore(),
): CodeTaskManager {
  const manager = new CodeTaskManager({
    ownerQQ: OWNER_QQ,
    allowGroups: [555],
    store,
    bridge,
    sender,
    pollIntervalMs: 20,
    summaryMaxChars: 2000,
    now: () => NOW,
    onWarn: (message) => warnings.push(message),
  });
  managers.push(manager);
  return manager;
}

function incoming(overrides: Partial<IncomingCodeCommand> = {}): IncomingCodeCommand {
  return {
    requestId: 'evt:incoming',
    text: 'code ds-memory 修复问题',
    source: { kind: 'private', id: OWNER },
    senderQQ: OWNER,
    ...overrides,
  };
}

describe('CodeTaskManager permissions and parsing', () => {
  it.each([
    [
      '普通成员群聊 @',
      { source: { kind: 'group' as const, id: '555' }, senderQQ: '999', isAtBot: true },
    ],
    [
      'owner 群聊未 @',
      { source: { kind: 'group' as const, id: '555' }, senderQQ: OWNER, isAtBot: false },
    ],
    [
      'owner 群聊不在白名单',
      { source: { kind: 'group' as const, id: '556' }, senderQQ: OWNER, isAtBot: true },
    ],
    [
      'owner 私聊但 sender 不匹配',
      { source: { kind: 'private' as const, id: OWNER }, senderQQ: '999' },
    ],
    [
      '陌生私聊',
      { source: { kind: 'private' as const, id: '999' }, senderQQ: '999' },
    ],
  ])('%s：拒绝且不调用 bridge、不建任务', async (_name, overrides) => {
    const bridge = new FakeBridge();
    const manager = newManager(bridge, senderWith([allSent()]).sender);

    const messages = await manager.handleIncoming(
      incoming({ ...overrides, text: 'code xtds 不应提交' }),
    );

    expect(messages).toEqual(['仅 owner 私聊或已授权群聊 @ 可使用 code 命令。']);
    expect(bridge.submitCalls).toHaveLength(0);
    expect(newStore().list()).toHaveLength(0);
  });

  it('owner 在白名单群 @ 时允许显式 code 命令', async () => {
    const bridge = new FakeBridge();
    const manager = newManager(bridge, senderWith([allSent()]).sender);

    const messages = await manager.handleIncoming(
      incoming({
        requestId: 'evt:owner-group-code',
        source: { kind: 'group', id: '555' },
        senderQQ: OWNER,
        isAtBot: true,
        text: ' code xtds 从群里提交任务',
      }),
    );

    expect(messages[0]).toContain('已提交代码任务');
    expect(bridge.submitCalls).toEqual([
      {
        requestId: 'evt:owner-group-code',
        repo: 'xtds',
        task: '从群里提交任务',
      },
    ]);
  });

  it.each(['code status', 'code cancel task-1'])(
    '非 owner 的 %j 也只拒绝，不读写任务',
    async (text) => {
      const bridge = new FakeBridge();
      const manager = newManager(bridge, senderWith([allSent()]).sender);

      const messages = await manager.handleIncoming(
        incoming({
          source: { kind: 'group', id: '555' },
          senderQQ: '999',
          isAtBot: true,
          text,
        }),
      );

      expect(messages).toEqual(['仅 owner 私聊或已授权群聊 @ 可使用 code 命令。']);
      expect(bridge.cancelCalls).toHaveLength(0);
      expect(newStore().list()).toHaveLength(0);
    },
  );

  it.each([
    'code',
    'code unknown-repo task',
    'code ds-memory',
    `code ds-memory ${'😀'.repeat(4001)}`,
  ])('owner 私聊非法命令 %j 回用法，不调用 bridge', async (text) => {
    const bridge = new FakeBridge();
    const manager = newManager(bridge, senderWith([allSent()]).sender);

    const messages = await manager.handleIncoming(incoming({ text }));

    expect(messages[0]).toContain('用法：code <repo> <task>');
    expect(bridge.submitCalls).toHaveLength(0);
  });
});

describe('CodeTaskManager submit', () => {
  it('ack 立即包含 taskId 与 repo；持久状态不存任务正文', async () => {
    const bridge = new FakeBridge();
    bridge.queuedTask = task({
      taskId: 'job-42',
      requestId: 'evt:submit',
      repo: 'ds-memory',
    });
    const manager = newManager(bridge, senderWith([allSent()]).sender);
    const secretTask = '实现一个很敏感的功能 XYZ';

    const messages = await manager.handleIncoming(
      incoming({ requestId: 'evt:submit', text: `code ds-memory ${secretTask}` }),
    );

    expect(messages).toEqual(['已提交代码任务 job-42（ds-memory）']);
    expect(bridge.submitCalls).toEqual([
      { requestId: 'evt:submit', repo: 'ds-memory', task: secretTask },
    ]);
    const persisted = readFileSync(codeTasksStatePath(stateDir), 'utf8');
    expect(persisted).not.toContain(secretTask);
    expect(persisted).not.toContain('taskPreview');
  });

  it('同一 requestId 串行与并发都只提交一次，并返回既有任务', async () => {
    const bridge = new FakeBridge();
    const manager = newManager(bridge, senderWith([allSent()]).sender);
    const input = incoming({ requestId: 'evt:duplicate' });

    const [first, second] = await Promise.all([
      manager.handleIncoming(input),
      manager.handleIncoming({ ...input, text: 'code xtds 不同正文' }),
    ]);
    const third = await manager.handleIncoming(input);

    expect(bridge.submitCalls).toHaveLength(1);
    expect(first).toEqual(second);
    expect(third).toEqual(first);
    expect(first[0]).toContain('task-1');
  });

  it.each([
    [new CodeBridgeError('offline'), '代码桥离线'],
    [new CodeBridgeError('queue_full'), '队列已满'],
    [new CodeBridgeError('unauthorized'), '鉴权失败'],
  ])('bridge 错误给稳定短消息且不落状态', async (error, expected) => {
    const bridge = new FakeBridge();
    bridge.submitError = error;
    const manager = newManager(bridge, senderWith([allSent()]).sender);

    const messages = await manager.handleIncoming(incoming({ requestId: 'evt:error' }));

    expect(messages[0]).toContain(expected);
    expect(messages[0]).not.toContain('token');
    expect(newStore().list()).toHaveLength(0);
  });
});

describe('CodeTaskManager status and cancel', () => {
  it('status 汇总本地排队/运行/最近终态', async () => {
    const store = newStore();
    store.upsert(record({ requestId: 'r1', taskId: 'queued-1', status: 'queued' }));
    store.upsert(
      record({
        requestId: 'r2',
        taskId: 'running-1',
        repo: 'qq-gateway',
        status: 'running',
        submittedAt: NOW + 1,
      }),
    );
    store.upsert(
      record({
        requestId: 'r3',
        taskId: 'done-1',
        repo: 'xtds-assistant-dsh',
        status: 'succeeded',
        updatedAt: NOW + 3,
      }),
    );
    const manager = newManager(new FakeBridge(), senderWith([allSent()]).sender, store);

    const messages = await manager.handleIncoming(incoming({ text: 'code status' }));

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('排队 1，运行 1，最近终态 1');
    expect(messages[0]).toContain('queued-1（xtds）：queued');
    expect(messages[0]).toContain('running-1（qq-gateway）：running');
    expect(messages[0]).toContain('done-1（xtds-assistant-dsh）：succeeded');
  });

  it('cancel 调 bridge 并立即回执；未知与终态明确拒绝', async () => {
    const store = newStore();
    store.upsert(record({ requestId: 'r1', taskId: 'live-1', status: 'running' }));
    store.upsert(record({ requestId: 'r2', taskId: 'done-1', status: 'succeeded' }));
    const bridge = new FakeBridge();
    bridge.cancelResult = task({
      taskId: 'live-1',
      requestId: 'r1',
      repo: 'xtds',
      status: 'running',
    });
    const manager = newManager(bridge, senderWith([allSent()]).sender, store);

    const live = await manager.handleIncoming(
      incoming({ text: 'code cancel live-1' }),
    );
    const done = await manager.handleIncoming(
      incoming({ text: 'code cancel done-1' }),
    );
    const missing = await manager.handleIncoming(
      incoming({ text: 'code cancel missing-1' }),
    );

    expect(live).toEqual(['已请求取消代码任务 live-1（xtds）。']);
    expect(bridge.cancelCalls).toEqual(['live-1']);
    expect(store.findByTaskId('live-1')?.cancelRequestedAt).toBe(NOW);
    expect(done[0]).toContain('已结束（succeeded）');
    expect(missing[0]).toContain('未找到代码任务');
  });
});

describe('CodeTaskManager polling and notifications', () => {
  it('终态通过 owner 私聊 proactive 单条发送并标记 sent', async () => {
    const store = newStore();
    store.upsert(record({ requestId: 'r1', taskId: 'job-1' }));
    const bridge = new FakeBridge();
    bridge.polledTask = task({
      taskId: 'job-1',
      requestId: 'r1',
      repo: 'xtds',
      status: 'succeeded',
      updatedAt: NOW + 1,
      finishedAt: NOW + 1,
      summary: '完成',
      changedFiles: ['src/a.ts'],
    });
    const { sender, calls } = senderWith([allSent()]);
    const manager = newManager(bridge, sender, store);

    await manager.pollOnce();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      target: { kind: 'private', id: OWNER },
      opts: { reason: 'proactive' },
    });
    expect(calls[0]?.messages).toHaveLength(1);
    expect(calls[0]?.messages[0]).toContain('job-1');
    expect(calls[0]?.messages[0]).toContain('succeeded');
    expect(calls[0]?.messages[0]).toContain('完成');
    expect(store.findByTaskId('job-1')).toMatchObject({
      notificationStatus: 'sent',
      notifiedAt: NOW,
    });
  });

  it('终态通知把稳定失败码翻译为可读原因', async () => {
    const store = newStore();
    store.upsert(
      record({
        requestId: 'r-preset',
        taskId: 'job-preset',
        status: 'failed',
        error: 'session_preset_incompatible',
      }),
    );
    const { sender, calls } = senderWith([allSent()]);
    const manager = newManager(new FakeBridge(), sender, store);

    await manager.pollOnce();

    const message = calls[0]?.messages[0] ?? '';
    expect(message).toContain('桌面端预设');
    expect(message).toContain('session_preset_incompatible');
    expect(message).not.toContain('错误：session_preset_incompatible');
  });

  it('none_sent 保留 pending 并在下一轮重试', async () => {
    const store = newStore();
    store.upsert(
      record({ requestId: 'r1', taskId: 'job-1', status: 'succeeded' }),
    );
    const { sender, calls } = senderWith([noneSent(), allSent()]);
    const manager = newManager(new FakeBridge(), sender, store);

    await manager.pollOnce();
    expect(store.findByTaskId('job-1')?.notificationStatus).toBe('pending');

    await manager.pollOnce();
    expect(calls).toHaveLength(2);
    expect(store.findByTaskId('job-1')?.notificationStatus).toBe('sent');
  });

  it('ambiguous_failure 标记 ambiguous，后续轮询绝不重发', async () => {
    const store = newStore();
    store.upsert(
      record({ requestId: 'r1', taskId: 'job-1', status: 'failed' }),
    );
    const { sender, calls } = senderWith([ambiguous()]);
    const manager = newManager(new FakeBridge(), sender, store);

    await manager.pollOnce();
    await manager.pollOnce();

    expect(calls).toHaveLength(1);
    expect(store.findByTaskId('job-1')).toMatchObject({
      notificationStatus: 'ambiguous',
      notifiedAt: null,
    });
  });

  it('非法 SendResult 标记 ambiguous，后续轮询绝不重发', async () => {
    const store = newStore();
    store.upsert(
      record({ requestId: 'r1', taskId: 'job-1', status: 'succeeded' }),
    );
    const invalid = {
      outcome: 'partial',
      sentIndexes: [],
      failedIndexes: [0],
      retryable: false,
      retryAfterMs: null,
      reason: 'bad',
    } as SendResult;
    const { sender, calls } = senderWith([invalid, allSent()]);
    const manager = newManager(new FakeBridge(), sender, store);

    await manager.pollOnce();
    await manager.pollOnce();

    expect(calls).toHaveLength(1);
    expect(store.findByTaskId('job-1')?.notificationStatus).toBe(
      'ambiguous',
    );
  });

  it('partial 但 sentIndexes 含 0 时按已送达处理', async () => {
    const store = newStore();
    store.upsert(
      record({ requestId: 'r1', taskId: 'job-1', status: 'succeeded' }),
    );
    const partial = {
      outcome: 'partial',
      sentIndexes: [0],
      failedIndexes: [],
      retryable: false,
      retryAfterMs: null,
      reason: 'reported_partial',
    } as SendResult;
    const manager = newManager(
      new FakeBridge(),
      senderWith([partial]).sender,
      store,
    );

    await manager.pollOnce();

    expect(store.findByTaskId('job-1')?.notificationStatus).toBe('sent');
  });

  it('终态消息对 summary/error 做 code point 上限截断', async () => {
    const store = newStore();
    const longSummary = `摘要${'甲'.repeat(100)}`;
    const longError = '乙'.repeat(400);
    store.upsert(
      record({
        requestId: 'r1',
        taskId: 'job-long',
        status: 'failed',
        summary: longSummary,
        error: longError,
      }),
    );
    const { sender, calls } = senderWith([allSent()]);
    const manager = new CodeTaskManager({
      ownerQQ: OWNER_QQ,
      store,
      bridge: new FakeBridge(),
      sender,
      summaryMaxChars: 40,
      now: () => NOW,
      onWarn: (message) => warnings.push(message),
    });
    managers.push(manager);

    await manager.pollOnce();

    const message = calls[0]?.messages[0] ?? '';
    expect(message).not.toContain(longSummary);
    expect(message).not.toContain(longError);
    expect(message).toContain('甲'.repeat(37));
    expect(message).toContain('乙'.repeat(299));
  });

  it('重启后恢复非终态轮询与终态 pending 通知', async () => {
    const firstStore = newStore();
    firstStore.upsert(
      record({
        requestId: 'active-r',
        taskId: 'active-task',
        repo: 'ds-memory',
        status: 'running',
        updatedAt: NOW,
      }),
    );
    firstStore.upsert(
      record({
        requestId: 'terminal-r',
        taskId: 'terminal-task',
        repo: 'qq-gateway',
        status: 'failed',
        updatedAt: NOW + 1,
        error: '旧错误',
        notificationStatus: 'pending',
      }),
    );

    const bridge = new FakeBridge();
    bridge.polledTask = task({
      taskId: 'active-task',
      requestId: 'active-r',
      repo: 'ds-memory',
      status: 'succeeded',
      updatedAt: NOW + 2,
      summary: '恢复完成',
    });
    const { sender, calls } = senderWith([allSent()]);
    const restartedStore = newStore();
    const restarted = newManager(bridge, sender, restartedStore);

    await restarted.pollOnce();

    expect(bridge.getCalls).toEqual(['active-task']);
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.opts?.reason === 'proactive')).toBe(true);
    expect(calls.flatMap((call) => call.messages).join('\n')).toContain('terminal-task');
    expect(calls.flatMap((call) => call.messages).join('\n')).toContain('active-task');
    expect(restartedStore.findByTaskId('terminal-task')?.notificationStatus).toBe(
      'sent',
    );
  });

  it('重启后 timed_out 仍按终态补发一次通知', async () => {
    const store = newStore();
    store.upsert(
      record({
        requestId: 'timeout-r',
        taskId: 'timeout-task',
        repo: 'xtds',
        status: 'timed_out',
        error: 'dsh_timeout',
        notificationStatus: 'pending',
      }),
    );
    const { sender, calls } = senderWith([allSent()]);
    const restarted = newManager(new FakeBridge(), sender, store);

    await restarted.pollOnce();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.messages[0]).toContain('timed_out');
    expect(store.findByTaskId('timeout-task')?.notificationStatus).toBe('sent');
  });

  it('pollOnce 防重入；stop 等待进行中的 poll', async () => {
    const store = newStore();
    store.upsert(record({ requestId: 'r1', taskId: 'job-1' }));
    const control: { release: ((task: CodeBridgeTask) => void) | null } = {
      release: null,
    };
    const pending = new Promise<CodeBridgeTask>((resolve) => {
      control.release = resolve;
    });
    const bridge: CodeBridgeApi = {
      async submit() {
        return task();
      },
      get() {
        return pending;
      },
      async cancel() {
        return task();
      },
      async listSessions() {
        return [];
      },
      async health() {
        return { name: 'code-bridge', ok: true };
      },
    };
    const manager = newManager(bridge, senderWith([allSent()]).sender, store);

    const first = manager.pollOnce();
    const second = manager.pollOnce();
    expect(second).toBe(first);

    let stopped = false;
    const stopping = manager.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(stopped).toBe(false);

    control.release?.(
      task({
        taskId: 'job-1',
        requestId: 'r1',
        repo: 'xtds',
        status: 'succeeded',
        updatedAt: NOW + 1,
      }),
    );
    await first;
    await stopping;
    expect(stopped).toBe(true);
  });
});

describe('CodeTaskManager sessions', () => {
  it('code sessions 输出标题、短 id、安全工作区与最近使用', async () => {
    const bridge = new FakeBridge();
    bridge.sessions = [
      session({
        sessionId: 'session-900fee51-aaaaaaaa',
        title: '修复工具接线',
        workspace: 'C:\\work\\private\\ds-memory',
      }),
      session({
        sessionId: 'session-900fee52-bbbbbbbb',
        title: '  ',
        workspace: '',
      }),
      session({
        sessionId: 'short',
        title: '短 id',
        workspace: '',
      }),
    ];
    const manager = newManager(bridge, senderWith([allSent()]).sender);

    const messages = await manager.handleIncoming(
      incoming({ text: 'code sessions 工具' }),
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('匹配“工具”的 DSH 会话');
    expect(messages[0]).toContain('1. 修复工具接线（session-900fee51）');
    expect(messages[0]).toContain('— ds-memory；最近');
    expect(messages[0]).not.toContain('C:\\work');
    expect(messages[0]).toContain('2. 未命名会话（session-900fee52）— 无工作区');
    expect(messages[0]).toContain('3. 短 id（short）— 无工作区');
    expect(messages[0]).toContain('session-900fee51');
    expect(messages[0]).toContain('session-900fee52');
    expect(bridge.sessionCalls).toEqual([{ query: '工具', limit: 20 }]);
  });

  it('空会话列表明确说明，不调用 submit', async () => {
    const bridge = new FakeBridge();
    const manager = newManager(bridge, senderWith([allSent()]).sender);

    const messages = await manager.handleIncoming(incoming({ text: 'code sessions' }));

    expect(messages).toEqual(['当前 DSH 会话（按最近使用）：\n当前没有可用的 DSH 会话。']);
    expect(bridge.submitCalls).toHaveLength(0);
  });

  it('标注不可恢复的桌面端会话并提示替代方式', async () => {
    const bridge = new FakeBridge();
    bridge.sessions = [
      session({ title: '桌面会话', resumable: false }),
      session({ title: '可恢复会话' }),
    ];
    const manager = newManager(bridge, senderWith([allSent()]).sender);

    const messages = await manager.handleIncoming(incoming({ text: 'code sessions' }));
    const text = messages[0] ?? '';

    expect(text).toContain('桌面会话');
    expect(text).toContain('不可恢复（桌面端预设）');
    expect(text).toContain('workspace + newSession: true');
    expect(text).not.toContain('可恢复会话；不可恢复');
  });

  it('最多展示 10 条并提示还有 N 个', async () => {
    const bridge = new FakeBridge();
    bridge.sessions = Array.from({ length: 13 }, (_value, index) =>
      session({
        sessionId: `sess-${index}`,
        title: `会话 ${index}`,
      }),
    );
    const manager = newManager(bridge, senderWith([allSent()]).sender);

    const messages = await manager.handleIncoming(incoming({ text: 'code sessions' }));
    const text = messages[0] ?? '';

    expect(text).toContain('10. 会话 9');
    expect(text).not.toContain('11. 会话 10');
    expect(text).toContain('还有 3 个');
  });

  it('manager 直接收到超长或换行 query 时返回用法式拒绝', async () => {
    const bridge = new FakeBridge();
    const manager = newManager(bridge, senderWith([allSent()]).sender);

    expect(await manager.listSessionsMessage('a'.repeat(101))).toEqual([
      '会话查询不合法：关键词必须单行且不超过 100 字。',
    ]);
    expect(await manager.listSessionsMessage('第一行\n第二行')).toEqual([
      '会话查询不合法：关键词必须单行且不超过 100 字。',
    ]);
    expect(bridge.sessionCalls).toHaveLength(0);
  });
});

describe('CodeTaskManager tool calls', () => {
  it('只接受 owner 私聊来源；无来源视为 runtime 内部调用', async () => {
    const bridge = new FakeBridge();
    const manager = newManager(bridge, senderWith([allSent()]).sender);
    const args = JSON.stringify({ task: '修复', repo: 'ds-memory' });

    const forbidden = await manager.handleToolCall({
      requestId: 'tool:evt-1:0123456789abcdef',
      tool: 'code_task',
      argumentsText: args,
      source: { kind: 'group', id: '555' },
      senderQQ: OWNER,
    });
    expect(forbidden).toEqual([
      '[code_tool_error:forbidden] 仅 owner 私聊可使用代码工具。',
    ]);

    const forged = await manager.handleToolCall({
      requestId: 'tool:evt-1:0123456789abcdef',
      tool: 'code_task',
      argumentsText: args,
      source: { kind: 'private', id: OWNER },
      senderQQ: '999',
    });
    expect(forged).toEqual([
      '[code_tool_error:forbidden] 仅 owner 私聊可使用代码工具。',
    ]);
    expect(bridge.submitCalls).toHaveLength(0);
  });

  it('校验 requestId、任务长度与目标参数', async () => {
    const bridge = new FakeBridge();
    const manager = newManager(bridge, senderWith([allSent()]).sender);

    const badRequest = await manager.handleToolCall({
      requestId: 'x'.repeat(257),
      tool: 'code_task',
      argumentsText: JSON.stringify({ task: '修复', repo: 'ds-memory' }),
    });
    expect(badRequest[0]).toContain('[code_tool_error:invalid_request]');

    const missingTask = await manager.handleToolCall({
      requestId: 'tool:evt-1:0123456789abcdef',
      tool: 'code_task',
      argumentsText: JSON.stringify({ repo: 'ds-memory' }),
    });
    expect(missingTask[0]).toContain('[code_tool_error:missing_task]');

    const tooLong = await manager.handleToolCall({
      requestId: 'tool:evt-1:0123456789abcdef',
      tool: 'code_task',
      argumentsText: JSON.stringify({ task: '甲'.repeat(4001), repo: 'ds-memory' }),
    });
    expect(tooLong[0]).toContain('[code_tool_error:task_too_long]');

    const missingTarget = await manager.handleToolCall({
      requestId: 'tool:evt-1:0123456789abcdef',
      tool: 'code_task',
      argumentsText: JSON.stringify({ task: '修复' }),
    });
    expect(missingTarget[0]).toContain('[code_tool_error:missing_target]');
    expect(missingTarget[0]).toContain('先调用 code_sessions');

    const badRepo = await manager.handleToolCall({
      requestId: 'tool:evt-1:0123456789abcdef',
      tool: 'code_task',
      argumentsText: JSON.stringify({ task: '修复', repo: 'sessions' }),
    });
    expect(badRepo[0]).toContain('[code_tool_error:invalid_target]');

    const extraPath = await manager.handleToolCall({
      requestId: 'tool:evt-1:0123456789abcdef',
      tool: 'code_task',
      argumentsText: JSON.stringify({
        task: '修复',
        repo: 'ds-memory',
        path: 'E:\\secret',
      }),
    });
    expect(extraPath[0]).toContain('[code_tool_error:invalid_arguments]');
    expect(bridge.submitCalls).toHaveLength(0);
  });

  it('repo 提交回执含 taskId、repo 目标与前 80 字单行预览', async () => {
    const bridge = new FakeBridge();
    bridge.queuedTask = task({
      taskId: 'job-tool-repo',
      requestId: 'tool:evt-repo:0123456789abcdef',
      repo: 'ds-memory',
    });
    const manager = newManager(bridge, senderWith([allSent()]).sender);
    const taskText = `${'甲'.repeat(80)}乙\n第三行`;

    const messages = await manager.handleToolCall({
      requestId: 'tool:evt-repo:0123456789abcdef',
      tool: 'code_task',
      argumentsText: JSON.stringify({ task: taskText, repo: 'ds-memory' }),
      source: { kind: 'private', id: OWNER },
      senderQQ: OWNER,
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('已提交代码任务 job-tool-repo（目标：ds-memory）');
    expect(messages[0]).toContain(`任务预览：${'甲'.repeat(80)}…`);
    expect(messages[0]).not.toContain('乙');
    expect(messages[0]).not.toContain('第三行');
    expect(bridge.submitCalls).toEqual([
      {
        requestId: 'tool:evt-repo:0123456789abcdef',
        task: taskText.trim(),
        repo: 'ds-memory',
      },
    ]);
  });

  it('恢复会话回执显示会话标题而不是 dsh-session', async () => {
    const bridge = new FakeBridge();
    bridge.queuedTask = task({
      taskId: 'job-tool-session',
      requestId: 'tool:evt-session:0123456789abcdef',
      repo: 'dsh-session',
      sessionId: 'sess-12345678',
      workspace: 'ds-memory',
      mode: 'resume',
    });
    bridge.sessions = [
      session({
        sessionId: 'sess-12345678',
        title: '旧会话',
        workspace: 'ds-memory',
      }),
    ];
    const manager = newManager(bridge, senderWith([allSent()]).sender);

    const messages = await manager.handleToolCall({
      requestId: 'tool:evt-session:0123456789abcdef',
      tool: 'code_task',
      argumentsText: JSON.stringify({ task: '继续修复', session: '旧会话' }),
    });

    expect(messages[0]).toContain('目标：会话《旧会话》');
    expect(messages[0]).not.toContain('dsh-session');
    expect(bridge.submitCalls[0]).toMatchObject({
      session: '旧会话',
      task: '继续修复',
    });
  });

  it('桌面端会话预设不兼容时提示改用工作区新建，并附候选会话', async () => {
    const bridge = new FakeBridge();
    bridge.submitError = new CodeBridgeError('session_preset_incompatible');
    bridge.sessions = [session({ title: '可恢复会话' })];
    const manager = newManager(bridge, senderWith([allSent()]).sender);

    const messages = await manager.handleToolCall({
      requestId: 'tool:evt-preset:0123456789abcdef',
      tool: 'code_task',
      argumentsText: JSON.stringify({ task: '继续修复', session: '桌面会话' }),
      source: { kind: 'private', id: OWNER },
      senderQQ: OWNER,
    });

    expect(messages[0]).toContain('桌面端预设');
    expect(messages[0]).toContain('newSession: true');
    expect(messages[0]).toContain('可恢复会话');
  });

  it('workspace 回执显示工作区标签且不泄露绝对路径', async () => {
    const bridge = new FakeBridge();
    bridge.queuedTask = task({
      taskId: 'job-tool-workspace',
      requestId: 'tool:evt-workspace:0123456789abcdef',
      repo: 'dsh-session',
      workspace: 'C:\\work\\private\\ds-memory',
      mode: 'workspace',
    });
    const manager = newManager(bridge, senderWith([allSent()]).sender);

    const messages = await manager.handleToolCall({
      requestId: 'tool:evt-workspace:0123456789abcdef',
      tool: 'code_task',
      argumentsText: JSON.stringify({
        task: '继续改',
        workspace: 'ds-memory',
      }),
    });

    expect(messages[0]).toContain('目标：工作区 ds-memory');
    expect(messages[0]).not.toContain('dsh-session');
    expect(messages[0]).not.toContain('C:\\work');
    expect(bridge.submitCalls[0]).toMatchObject({
      workspace: 'ds-memory',
      task: '继续改',
    });
  });

  it('会话/工作区未找到时自动附上当前会话列表', async () => {
    const bridge = new FakeBridge();
    bridge.submitError = new CodeBridgeError('session_not_found');
    bridge.sessions = [
      session({ sessionId: 'sess-a', title: '候选 A' }),
      session({ sessionId: 'sess-b', title: '候选 B' }),
    ];
    const manager = newManager(bridge, senderWith([allSent()]).sender);

    const messages = await manager.handleToolCall({
      requestId: 'tool:evt-miss:0123456789abcdef',
      tool: 'code_task',
      argumentsText: JSON.stringify({ task: '继续', session: '不存在的会话' }),
    });

    expect(messages[0]).toContain('找不到指定会话');
    expect(messages[0]).toContain('候选 A');
    expect(messages[0]).toContain('候选 B');
    expect(bridge.sessionCalls).toEqual([{ query: undefined, limit: 20 }]);
    expect(newStore().list()).toHaveLength(0);
  });

  it('code_sessions 透传 query，code_status 复用本地状态文本', async () => {
    const store = newStore();
    store.upsert(record({ requestId: 'r1', taskId: 'queued-1' }));
    const bridge = new FakeBridge();
    bridge.sessions = [session({ title: '命中会话' })];
    const manager = newManager(bridge, senderWith([allSent()]).sender, store);

    const sessions = await manager.handleToolCall({
      requestId: 'tool:evt-sessions:0123456789abcdef',
      tool: 'code_sessions',
      argumentsText: JSON.stringify({ query: '命中' }),
    });
    const status = await manager.handleToolCall({
      requestId: 'tool:evt-status:0123456789abcdef',
      tool: 'code_status',
      argumentsText: '',
    });

    expect(sessions[0]).toContain('命中会话');
    expect(bridge.sessionCalls[0]).toEqual({ query: '命中', limit: 20 });
    expect(status[0]).toContain('排队 1');
  });
});
