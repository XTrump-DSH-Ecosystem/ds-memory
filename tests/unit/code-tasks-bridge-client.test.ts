import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CODE_BRIDGE_MAX_RESPONSE_BYTES,
  CodeBridgeClient,
  CodeBridgeError,
  type CodeBridgeFetch,
  type CodeBridgeTask,
} from '../../src/code-tasks/bridge-client.ts';

const NOW = 1_750_000_000_000;
const NOW_ISO = new Date(NOW).toISOString();
const LATER_ISO = new Date(NOW + 1_000).toISOString();
const PORT = 43123;
const TOKEN = 'bridge-token-placeholder-0123456789';
const TASK_ID = 'ct-00000000-0000-4000-8000-000000000001';

let rootDir: string;
let endpointFile: string;
let tokenFile: string;
let calls: Array<{ url: string; init?: RequestInit }>;

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'xds-code-bridge-client-'));
  endpointFile = join(rootDir, 'code-bridge.endpoint.json');
  tokenFile = join(rootDir, 'code-bridge.token');
  calls = [];
  writeFileSync(tokenFile, `${TOKEN}\n`, 'utf8');
  writeEndpoint();
});

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

function writeEndpoint(
  overrides: Partial<{
    v: unknown;
    name: unknown;
    host: unknown;
    port: unknown;
    pid: unknown;
  }> = {},
): void {
  writeFileSync(
    endpointFile,
    JSON.stringify({
      v: 1,
      name: 'code-bridge',
      host: '127.0.0.1',
      port: PORT,
      pid: process.pid,
      startedAt: NOW,
      instanceId: 'bridge-instance',
      ...overrides,
    }),
    'utf8',
  );
}

function timestamps(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    createdAt: NOW_ISO,
    queuedAt: NOW_ISO,
    startedAt: null,
    finishedAt: null,
    updatedAt: NOW_ISO,
    ...overrides,
  };
}

function wireTask(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    taskId: TASK_ID,
    requestId: 'evt:1',
    repo: 'ds-memory',
    status: 'queued',
    worktree: null,
    changedFiles: [],
    diffStat: { files: 0, insertions: 0, deletions: 0 },
    summary: null,
    error: null,
    timestamps: timestamps(),
    outputTruncated: false,
    cancelRequestedAt: null,
    ...overrides,
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function taskEnvelope(
  taskValue: unknown = wireTask(),
  status = 200,
  duplicate?: boolean,
): Response {
  return jsonResponse(
    {
      ok: true,
      ...(duplicate === undefined ? {} : { duplicate }),
      task: taskValue,
    },
    status,
  );
}

function wireSession(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    sessionId: 'sess-00000000-0000-4000-8000-000000000001',
    title: '修复 ds-memory 的工具接线',
    workspace: 'ds-memory',
    lastUsedAt: NOW_ISO,
    resumable: true,
    ...overrides,
  };
}

function sessionsEnvelope(
  sessions: unknown[] = [wireSession()],
  status = 200,
): Response {
  return jsonResponse({ ok: true, sessions }, status);
}

function client(fetchImpl: CodeBridgeFetch, timeoutMs = 1000): CodeBridgeClient {
  return new CodeBridgeClient({
    endpointFile,
    tokenFile,
    timeoutMs,
    fetchImpl,
    isPidAlive: () => true,
  });
}

describe('CodeBridgeClient request shape', () => {
  it('只连字面量回环地址，token 仅放 x-code-bridge-token，且每次重读 token', async () => {
    const fetchImpl: CodeBridgeFetch = async (input, init) => {
      calls.push({ url: String(input), init });
      const body =
        init?.body === undefined
          ? null
          : (JSON.parse(String(init.body)) as {
              requestId: string;
              repo: CodeBridgeTask['repo'];
            });
      return taskEnvelope(
        wireTask({
          taskId: body === null ? 'task-1' : `id-${calls.length}`,
          requestId: body?.requestId ?? 'evt:1',
          repo: body?.repo ?? 'ds-memory',
        }),
        body === null ? 200 : 202,
        body === null ? undefined : false,
      );
    };
    const bridge = client(fetchImpl);

    const first = await bridge.submit({
      requestId: 'evt:owner',
      repo: 'qq-gateway',
      task: '修复 code',
    });
    expect(first).toMatchObject({
      taskId: 'id-1',
      requestId: 'evt:owner',
      repo: 'qq-gateway',
      createdAt: NOW,
      updatedAt: NOW,
    });

    writeFileSync(tokenFile, 'second-token-placeholder\n', 'utf8');
    await bridge.get('task-1');

    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe(`http://127.0.0.1:${PORT}/v1/tasks`);
    const firstHeaders = new Headers(calls[0]?.init?.headers);
    const secondHeaders = new Headers(calls[1]?.init?.headers);
    expect(firstHeaders.get('x-code-bridge-token')).toBe(TOKEN);
    expect(secondHeaders.get('x-code-bridge-token')).toBe(
      'second-token-placeholder',
    );
    expect(firstHeaders.get('authorization')).toBeNull();
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      requestId: 'evt:owner',
      repo: 'qq-gateway',
      task: '修复 code',
    });
    expect(calls[1]?.url).toBe(`http://127.0.0.1:${PORT}/v1/tasks/task-1`);
  });

  it('GET /health 与 cancel 使用正确路径并校验结果', async () => {
    const fetchImpl: CodeBridgeFetch = async (input, init) => {
      calls.push({ url: String(input), init });
      if (String(input).endsWith('/health')) {
        return jsonResponse({
          ok: true,
          name: 'code-bridge',
          version: '0.1.0',
          pid: 1234,
          uptimeMs: 1,
          running: 0,
          queued: 0,
        });
      }
      return taskEnvelope(
        wireTask({ taskId: 'task/with space', status: 'canceled' }),
      );
    };
    const bridge = client(fetchImpl);

    await expect(bridge.health()).resolves.toEqual({
      name: 'code-bridge',
      ok: true,
    });
    await expect(bridge.cancel('task/with space')).resolves.toMatchObject({
      status: 'canceled',
    });
    expect(calls[1]?.url).toBe(
      `http://127.0.0.1:${PORT}/v1/tasks/task%2Fwith%20space/cancel`,
    );
  });

  it('响应中的 token 不进入文本字段', async () => {
    const bridge = client(async () =>
      taskEnvelope(
        wireTask({
          summary: `summary ${TOKEN}`,
          error: `error ${TOKEN}`,
          worktree: `/tmp/${TOKEN}`,
          changedFiles: [`a-${TOKEN}.ts`],
        }),
      ),
    );

    const result = await bridge.get(TASK_ID);

    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(result.summary).toContain('[REDACTED]');
    expect(result.error).toContain('[REDACTED]');
    expect(result.worktree).toContain('[REDACTED]');
    expect(result.changedFiles[0]).toContain('[REDACTED]');
  });

  it('提交会话/工作区目标时只发送存在的可选字段', async () => {
    const bodies: unknown[] = [];
    const fetchImpl: CodeBridgeFetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { requestId: string };
      bodies.push(body);
      return taskEnvelope(
        wireTask({
          requestId: body.requestId,
          repo: 'dsh-session',
          sessionId: 'sess-1',
          workspace: 'ds-memory',
          mode: 'resume',
        }),
      );
    };
    const bridge = client(fetchImpl);

    const result = await bridge.submit({
      requestId: 'tool:evt-1:abcdef0123456789',
      task: '继续上次的修复',
      session: '上次的修复',
      newSession: false,
    });

    expect(bodies).toEqual([
      {
        requestId: 'tool:evt-1:abcdef0123456789',
        task: '继续上次的修复',
        session: '上次的修复',
        newSession: false,
      },
    ]);
    expect(result).toMatchObject({
      repo: 'dsh-session',
      sessionId: 'sess-1',
      workspace: 'ds-memory',
      mode: 'resume',
    });
  });

  it('无 repo 且无会话/工作区目标时本地拒绝，不发请求', async () => {
    let called = false;
    const bridge = client(async () => {
      called = true;
      return taskEnvelope();
    });

    await expect(
      bridge.submit({ requestId: 'evt:no-target', task: 'x' }),
    ).rejects.toMatchObject({ code: 'response_invalid' });
    expect(called).toBe(false);
  });

  it('显式 sessionId 与响应不一致时拒绝', async () => {
    const bridge = client(async () =>
      taskEnvelope(
        wireTask({
          requestId: 'evt:session-id',
          repo: 'dsh-session',
          sessionId: 'sess-other',
          mode: 'resume',
        }),
      ),
    );

    await expect(
      bridge.submit({
        requestId: 'evt:session-id',
        task: '继续',
        sessionId: 'sess-expected',
      }),
    ).rejects.toMatchObject({ code: 'response_invalid' });
  });
});

describe('CodeBridgeClient sessions', () => {
  it('GET /v1/sessions 携带 q/limit，严格解析 ISO 与安全字段', async () => {
    const calls2: string[] = [];
    const bridge = client(async (input) => {
      calls2.push(String(input));
      return sessionsEnvelope([
        wireSession(),
        wireSession({
          sessionId: 'sess-2',
          title: '',
          workspace: '',
          lastUsedAt: LATER_ISO,
          resumable: false,
        }),
      ]);
    });

    const sessions = await bridge.listSessions('  ds-memory  ', 20);

    const url = new URL(calls2[0]!);
    expect(url.pathname).toBe('/v1/sessions');
    expect(url.searchParams.get('q')).toBe('ds-memory');
    expect(url.searchParams.get('limit')).toBe('20');
    expect(sessions).toEqual([
      {
        sessionId: 'sess-00000000-0000-4000-8000-000000000001',
        title: '修复 ds-memory 的工具接线',
        workspace: 'ds-memory',
        lastUsedAt: NOW,
        resumable: true,
      },
      {
        sessionId: 'sess-2',
        title: '',
        workspace: '',
        lastUsedAt: Date.parse(LATER_ISO),
        resumable: false,
      },
    ]);
  });

  it('listSessions 无参数时请求裸路径', async () => {
    const urls: string[] = [];
    const bridge = client(async (input) => {
      urls.push(String(input));
      return sessionsEnvelope([]);
    });

    await expect(bridge.listSessions()).resolves.toEqual([]);
    expect(urls).toEqual([`http://127.0.0.1:${PORT}/v1/sessions`]);
  });

  it.each([
    ['ok:false', { ok: false, sessions: [wireSession()] }],
    ['sessions 缺失', { ok: true }],
    ['sessions 非数组', { ok: true, sessions: {} }],
    ['sessionId 非法', { ok: true, sessions: [wireSession({ sessionId: '../x' })] }],
    ['sessionId 过长', { ok: true, sessions: [wireSession({ sessionId: 'a'.repeat(129) })] }],
    ['title 含控制字符', { ok: true, sessions: [wireSession({ title: 'a\nb' })] }],
    ['title 过长', { ok: true, sessions: [wireSession({ title: 'a'.repeat(201) })] }],
    ['workspace 含控制字符', { ok: true, sessions: [wireSession({ workspace: 'a\tb' })] }],
    ['workspace 过长', { ok: true, sessions: [wireSession({ workspace: 'a'.repeat(501) })] }],
    ['lastUsedAt 非 ISO', { ok: true, sessions: [wireSession({ lastUsedAt: 'today' })] }],
    ['resumable 非布尔', { ok: true, sessions: [wireSession({ resumable: 'no' })] }],
    ['重复 sessionId', { ok: true, sessions: [wireSession(), wireSession()] }],
    [
      '超过 20 条',
      {
        ok: true,
        sessions: Array.from({ length: 21 }, (_value, index) =>
          wireSession({ sessionId: `sess-${index}` }),
        ),
      },
    ],
  ])('拒绝非法 sessions envelope：%s', async (_label, payload) => {
    await expect(
      client(async () => jsonResponse(payload)).listSessions(),
    ).rejects.toMatchObject({ code: 'response_invalid' });
  });

  it('session 字段包含 token 时拒绝而不是回显', async () => {
    await expect(
      client(async () => sessionsEnvelope([wireSession({ title: TOKEN })])).listSessions(),
    ).rejects.toMatchObject({ code: 'response_invalid' });
  });

  it.each([
    [404, 'session_not_found'],
    [404, 'workspace_not_found'],
    [409, 'session_ambiguous'],
    [409, 'workspace_ambiguous'],
    [409, 'session_workspace_mismatch'],
    [409, 'session_preset_incompatible'],
  ] as const)('HTTP %s + error=%s 归一化为专用错误码', async (status, code) => {
    const bridge = client(async () =>
      jsonResponse({ ok: false, error: code }, status),
    );
    await expect(bridge.listSessions()).rejects.toMatchObject({ code });
  });

  it('404 无结构化 error 仍归一化为 not_found', async () => {
    const bridge = client(async () =>
      new Response('{"ok":false,"detail":"hidden"}', { status: 404 }),
    );
    await expect(bridge.listSessions()).rejects.toMatchObject({ code: 'not_found' });
  });

  it('超过 64 KiB 的 sessions 响应被拒绝', async () => {
    const oversized = sessionsEnvelope([
      wireSession({ title: 'x'.repeat(CODE_BRIDGE_MAX_RESPONSE_BYTES) }),
    ]);
    await expect(client(async () => oversized).listSessions()).rejects.toMatchObject({
      code: 'response_invalid',
    });
  });
});

describe('CodeBridgeClient discovery and error normalization', () => {
  it.each([
    [{ name: 'other' }, 'name'],
    [{ host: 'localhost' }, 'host'],
    [{ host: '192.168.1.2' }, 'non-loopback'],
    [{ port: 0 }, 'port'],
    [{ port: 65_536 }, 'port'],
    [{ v: 2 }, 'version'],
  ])('非法端点 %j 返回 offline 且不发请求', async (overrides, _label) => {
    writeEndpoint(overrides);
    const fetchImpl: CodeBridgeFetch = async () => {
      calls.push({ url: 'unexpected' });
      return taskEnvelope();
    };
    const bridge = client(fetchImpl);

    await expect(bridge.get(TASK_ID)).rejects.toMatchObject({ code: 'offline' });
    expect(calls).toHaveLength(0);
  });

  it('pid 已死、文件缺失或 token 空均按 offline 处理', async () => {
    const bridge = new CodeBridgeClient({
      endpointFile,
      tokenFile,
      fetchImpl: async () => taskEnvelope(),
      isPidAlive: () => false,
    });
    await expect(bridge.get(TASK_ID)).rejects.toMatchObject({ code: 'offline' });

    writeFileSync(tokenFile, '   \n', 'utf8');
    await expect(
      client(async () => taskEnvelope()).get(TASK_ID),
    ).rejects.toMatchObject({ code: 'offline' });
  });

  it.each([
    [401, 'unauthorized'],
    [403, 'unauthorized'],
    [404, 'not_found'],
    [429, 'queue_full'],
    [500, 'http_error'],
    [503, 'http_error'],
  ])('HTTP %s 归一化为 %s，且不回显 body/token', async (status, code) => {
    const secretBody = `{"error":"${TOKEN}","detail":"private-body"}`;
    const bridge = client(
      async () =>
        new Response(secretBody, {
          status,
          headers: { 'content-type': 'application/json' },
        }),
    );

    try {
      await bridge.submit({ requestId: 'evt:fail', repo: 'xtds', task: 'x' });
      expect.fail('应当失败');
    } catch (err) {
      expect(err).toBeInstanceOf(CodeBridgeError);
      expect((err as CodeBridgeError).code).toBe(code);
      expect((err as Error).message).not.toContain(TOKEN);
      expect((err as Error).message).not.toContain('private-body');
    }
  });

  it('超时归一化为 timeout', async () => {
    const bridge = client(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        }),
      10,
    );

    await expect(bridge.get(TASK_ID)).rejects.toMatchObject({ code: 'timeout' });
  });

  it('网络异常归一化为 offline', async () => {
    const bridge = client(async () => {
      throw new TypeError('connect ECONNREFUSED secret-body');
    });
    await expect(bridge.get(TASK_ID)).rejects.toMatchObject({ code: 'offline' });
  });
});

describe('CodeBridgeClient real envelope and task projection', () => {
  it('完整嵌套 envelope 解包 task、转换时间并归一化 diffStat', async () => {
    const createdAt = '2026-11-08T00:00:00.000Z';
    const startedAt = '2026-11-08T00:00:01.000Z';
    const finishedAt = '2026-11-08T00:00:04.000Z';
    const updatedAt = '2026-11-08T00:00:04.000Z';
    const cancelRequestedAt = '2026-11-08T00:00:02.000Z';
    const bridge = client(async () =>
      taskEnvelope(
        wireTask({
          taskId: TASK_ID,
          status: 'succeeded',
          worktree: 'C:\\worktrees\\ct-test',
          changedFiles: ['src/a.ts'],
          diffStat: { files: 3, insertions: 12, deletions: 4 },
          summary: '完成',
          timestamps: {
            createdAt,
            queuedAt: createdAt,
            startedAt,
            finishedAt,
            updatedAt,
          },
          outputTruncated: true,
          cancelRequestedAt,
        }),
      ),
    );

    const result = await bridge.get(TASK_ID);

    expect(result).toEqual({
      taskId: TASK_ID,
      requestId: 'evt:1',
      repo: 'ds-memory',
      status: 'succeeded',
      createdAt: Date.parse(createdAt),
      updatedAt: Date.parse(updatedAt),
      startedAt: Date.parse(startedAt),
      finishedAt: Date.parse(finishedAt),
      worktree: 'C:\\worktrees\\ct-test',
      changedFiles: ['src/a.ts'],
      diffStat: '3 files, +12/-4',
      summary: '完成',
      error: null,
      cancelRequestedAt: Date.parse(cancelRequestedAt),
    });
  });

  it('接受所有实际状态，包括 canceled 与 timed_out', async () => {
    for (const status of [
      'queued',
      'running',
      'succeeded',
      'failed',
      'canceled',
      'timed_out',
    ] as const) {
      const bridge = client(async () =>
        taskEnvelope(wireTask({ status })),
      );
      await expect(bridge.get(TASK_ID)).resolves.toMatchObject({ status });
    }
  });

  it('accepts an optional boolean duplicate and a missing duplicate', async () => {
    await expect(
      client(async () =>
        taskEnvelope(wireTask(), 202, false),
      ).submit({ requestId: 'evt:1', repo: 'ds-memory', task: 'x' }),
    ).resolves.toMatchObject({ status: 'queued' });
    await expect(
      client(async () =>
        taskEnvelope(wireTask(), 202),
      ).submit({ requestId: 'evt:1', repo: 'ds-memory', task: 'x' }),
    ).resolves.toMatchObject({ status: 'queued' });
  });

  it('normalizes a singular diffStat', async () => {
    const result = await client(async () =>
      taskEnvelope(
        wireTask({
          diffStat: { files: 1, insertions: 0, deletions: 2 },
        }),
      ),
    ).get(TASK_ID);

    expect(result.diffStat).toBe('1 file, +0/-2');
  });

  it.each([
    ['ok:false', { ok: false, task: wireTask() }],
    ['task 缺失', { ok: true }],
    ['task 非对象', { ok: true, task: 'not-an-object' }],
    ['duplicate 非 boolean', { ok: true, duplicate: 'false', task: wireTask() }],
  ])('拒绝非法 envelope：%s', async (_label, payload) => {
    await expect(
      client(async () => jsonResponse(payload)).get(TASK_ID),
    ).rejects.toMatchObject({ code: 'response_invalid' });
  });
});

describe('CodeBridgeClient strict response validation', () => {
  it.each([
    ['taskId 为空', { taskId: '' }],
    ['requestId 为空', { requestId: '' }],
    ['repo 不在 allowlist', { repo: 'unknown' }],
    ['旧状态 cancelled', { status: 'cancelled' }],
    ['未知状态', { status: 'done' }],
    ['createdAt 非 ISO', { timestamps: timestamps({ createdAt: 'yesterday' }) }],
    ['updatedAt 缺失', { timestamps: { createdAt: NOW_ISO, startedAt: null, finishedAt: null } }],
    ['queuedAt 非 ISO', { timestamps: timestamps({ queuedAt: 'not-a-time' }) }],
    ['timestamps 缺失', { timestamps: undefined }],
    ['diffStat 缺失', { diffStat: undefined }],
    ['diffStat 负数', { diffStat: { files: -1, insertions: 0, deletions: 0 } }],
    ['diffStat 非整数', { diffStat: { files: 1.5, insertions: 0, deletions: 0 } }],
    ['outputTruncated 非 boolean', { outputTruncated: 'false' }],
    ['changedFiles 非字符串', { changedFiles: [1] }],
    ['summary 非字符串', { summary: 42 }],
    ['cancelRequestedAt 非 ISO', { cancelRequestedAt: 'not-a-time' }],
    ['sessionId 非法', { sessionId: 'bad id' }],
    ['workspace 含控制字符', { workspace: 'a\nb' }],
    ['mode 未知', { mode: 'other' }],
    ['resume 但 repo 不是 dsh-session', { mode: 'resume' }],
    ['worktree 但 repo 是 dsh-session', { repo: 'dsh-session', mode: 'worktree' }],
  ])('非法 task shape：%s 返回 response_invalid', async (_label, override) => {
    await expect(
      client(async () => taskEnvelope(wireTask(override))).get(TASK_ID),
    ).rejects.toMatchObject({ code: 'response_invalid' });
  });

  it('requestId/taskId/repo 与调用不匹配时拒绝', async () => {
    await expect(
      client(async () =>
        taskEnvelope(wireTask({ requestId: 'other' })),
      ).submit({
        requestId: 'evt:expected',
        repo: 'xtds',
        task: 'x',
      }),
    ).rejects.toMatchObject({ code: 'response_invalid' });

    await expect(
      client(async () => taskEnvelope(wireTask({ taskId: 'other' }))).get(
        TASK_ID,
      ),
    ).rejects.toMatchObject({ code: 'response_invalid' });
  });

  it('非法 JSON 与超过 64 KiB 响应均拒绝', async () => {
    await expect(
      client(async () => new Response('{broken', { status: 200 })).get(TASK_ID),
    ).rejects.toMatchObject({ code: 'response_invalid' });

    const oversized = JSON.stringify({
      ...wireTask(),
      summary: 'x'.repeat(CODE_BRIDGE_MAX_RESPONSE_BYTES),
    });
    await expect(
      client(async () => new Response(oversized, { status: 200 })).get(TASK_ID),
    ).rejects.toMatchObject({ code: 'response_invalid' });
  });
});
