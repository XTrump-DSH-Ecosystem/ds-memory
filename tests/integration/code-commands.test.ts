import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  CodeBridgeApi,
  CodeBridgeFetch,
  CodeBridgeHealth,
  CodeBridgeSession,
  CodeBridgeTask,
  CodeBridgeTaskInput,
} from '../../src/code-tasks/bridge-client.ts';
import { CodeBridgeClient } from '../../src/code-tasks/bridge-client.ts';
import { CodeTaskStore } from '../../src/code-tasks/store.ts';
import { loadConfig, type AppConfig } from '../../src/config/load.ts';
import { EventStore, type RawRecord } from '../../src/memory/store.ts';
import { memoryEventsDir } from '../../src/state/paths.ts';
import {
  usageOfEvent,
  type ChatEvent,
  type ChatEventStream,
  type ChatRequest,
  type Provider,
} from '../../src/provider/types.ts';
import { HookServer, type ReservedHookEvent } from '../../src/qq/hooks.ts';
import { ReceiptStore } from '../../src/qq/receipts.ts';
import { startQqService, type QqService } from '../../src/qq/service.ts';
import { SessionMap } from '../../src/qq/session-map.ts';
import type { QqTarget } from '../../src/qq/types.ts';
import type { HookEvent } from '../../src/qq/wire.ts';

const NOW = 1_750_000_100_000;
const TOKEN = '0123456789abcdef0123456789abcdef0123456789abcdef';
const OWNER_QQ = 123456789;
const OWNER = String(OWNER_QQ);
const GROUP_ID = 555000111;
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

interface TestResponse {
  status: number;
  body: unknown;
  text: string;
}

interface HookSetup {
  server: HookServer;
  store: EventStore;
  receipts: ReceiptStore;
  sessionMap: SessionMap;
  callbacks: string[];
  reserved: ReservedHookEvent[];
  warnings: string[];
}

interface GatewayRequest {
  target: QqTarget;
  messages: string[];
  reason: string | undefined;
}

interface FakeGateway {
  port: number;
  requests: GatewayRequest[];
  close(): Promise<void>;
}

class FakeBridge implements CodeBridgeApi {
  readonly submitCalls: CodeBridgeTaskInput[] = [];
  readonly sessions: CodeBridgeSession[] = [];
  current: CodeBridgeTask = task();

  async submit(input: CodeBridgeTaskInput): Promise<CodeBridgeTask> {
    this.submitCalls.push({ ...input });
    this.current = task({
      requestId: input.requestId,
      repo: input.repo,
      taskId: `task-${this.submitCalls.length}`,
    });
    return this.current;
  }

  async get(): Promise<CodeBridgeTask> {
    return this.current;
  }

  async cancel(): Promise<CodeBridgeTask> {
    return this.current;
  }

  async listSessions(): Promise<CodeBridgeSession[]> {
    return [...this.sessions];
  }

  async health(): Promise<CodeBridgeHealth> {
    return { name: 'code-bridge', ok: true };
  }
}

function task(overrides: Partial<CodeBridgeTask> = {}): CodeBridgeTask {
  return {
    taskId: 'task-1',
    requestId: 'evt:code',
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

const TRANSPORT_TASK_ID = 'ct-00000000-0000-4000-8000-000000000001';
const TRANSPORT_CREATED_AT = new Date(NOW).toISOString();
const TRANSPORT_FINISHED_AT = new Date(NOW + 2_000).toISOString();

function wireTimestamps(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    createdAt: TRANSPORT_CREATED_AT,
    queuedAt: TRANSPORT_CREATED_AT,
    startedAt: null,
    finishedAt: null,
    updatedAt: TRANSPORT_CREATED_AT,
    ...overrides,
  };
}

function wireTask(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    taskId: TRANSPORT_TASK_ID,
    requestId: 'evt:code:transport',
    repo: 'ds-memory',
    status: 'queued',
    worktree: null,
    changedFiles: [],
    diffStat: { files: 0, insertions: 0, deletions: 0 },
    summary: null,
    error: null,
    timestamps: wireTimestamps(),
    outputTruncated: false,
    cancelRequestedAt: null,
    ...overrides,
  };
}

function providerSaying(
  text: string,
  counter: { calls: number; texts: string[] },
): Provider {
  return {
    id: 'deepseek',
    chat(req) {
      counter.calls += 1;
      counter.texts.push(req.messages.at(-1)?.content ?? '');
      return (async function* (): AsyncGenerator<ChatEvent> {
        yield { type: 'text', text };
        yield { type: 'done' };
      })();
    },
    usageOf: usageOfEvent,
    async health() {
      return { ok: true, detail: 'fake' };
    },
  };
}

function providerRecordingTools(counter: {
  calls: number;
  tools: string[][];
}): Provider {
  return {
    id: 'deepseek',
    supportsTools: true,
    chat(req: ChatRequest) {
      counter.calls += 1;
      counter.tools.push((req.tools ?? []).map((tool) => tool.name));
      return (async function* (): AsyncGenerator<ChatEvent> {
        yield { type: 'text', text: '收到。' };
        yield { type: 'done' };
      })();
    },
    usageOf: usageOfEvent,
    async health() {
      return { ok: true, detail: 'fake' };
    },
  };
}

let rootDir: string;
let stateDir: string;
let runtimeDir: string;
let hooks: HookServer[];
let services: QqService[];
let gateways: FakeGateway[];

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'xds-code-commands-'));
  stateDir = join(rootDir, 'state');
  runtimeDir = join(rootDir, 'runtime');
  hooks = [];
  services = [];
  gateways = [];
});

afterEach(async () => {
  while (services.length > 0) await services.pop()!.stop();
  while (hooks.length > 0) await hooks.pop()!.stop();
  while (gateways.length > 0) await gateways.pop()!.close();
  rmSync(rootDir, { recursive: true, force: true });
});

async function startHook(
  options: {
    denyPrivate?: number[];
    denyGroups?: number[];
    onCodeCommand?: ((event: HookEvent) => void) | null;
  } = {},
): Promise<HookSetup> {
  const store = new EventStore({
    dir: memoryEventsDir(stateDir),
    now: () => NOW,
    onWarn: () => undefined,
  });
  const receipts = new ReceiptStore({
    dir: join(stateDir, 'qq'),
    store,
    now: () => NOW,
    onWarn: () => undefined,
  });
  const sessionMap = new SessionMap({
    stateDir,
    ownerQQ: OWNER_QQ,
    allowGroups: [GROUP_ID],
    denyPrivate: options.denyPrivate ?? [],
    denyGroups: options.denyGroups ?? [],
    allowGroupMemberReply: true,
    groupWake: 'mention',
    now: () => NOW,
    onWarn: () => undefined,
  });
  const callbacks: string[] = [];
  const reserved: ReservedHookEvent[] = [];
  const warnings: string[] = [];
  const server = new HookServer({
    port: 0,
    token: TOKEN,
    runtimeDir,
    receipts,
    sessionMap,
    now: () => NOW,
    onWarn: (message) => warnings.push(message),
    instanceId: 'code-command-hook',
    onReserved: (entry) => reserved.push(entry),
    onCodeCommand:
      options.onCodeCommand === null
        ? undefined
        : options.onCodeCommand ??
          ((event) => {
            callbacks.push(event.eventId);
          }),
  });
  await server.start();
  hooks.push(server);
  return { server, store, receipts, sessionMap, callbacks, reserved, warnings };
}

function payload(
  eventId: string,
  text: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    v: 1,
    eventId,
    at: NOW,
    source: { kind: 'private', id: OWNER, groupName: null },
    sender: { qqId: OWNER, nickname: '主人' },
    messageId: eventId,
    text,
    isAtBot: false,
    quote: null,
    media: [],
    poke: null,
    ...overrides,
  };
}

async function request(
  server: HookServer,
  init: RequestInit,
): Promise<TestResponse> {
  const response = await fetch(`http://127.0.0.1:${server.port}/hook/message`, init);
  const text = await response.text();
  return { status: response.status, body: JSON.parse(text) as unknown, text };
}

async function postHook(
  server: HookServer,
  body: unknown,
  token: string | null = TOKEN,
): Promise<TestResponse> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token !== null) headers['x-memory-token'] = token;
  return request(server, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

function l0(): RawRecord[] {
  const store = new EventStore({
    dir: memoryEventsDir(stateDir),
    onWarn: () => undefined,
  });
  return store.listMonths().flatMap((month) => store.readMonth(month));
}

describe('HookServer code command short-circuit', () => {
  it('owner 私聊 code：只回调，不 reserve/L0/Receipt/会话', async () => {
    const setup = await startHook();

    const response = await postHook(
      setup.server,
      payload('evt:code:short-circuit', 'code ds-memory 修复 hook'),
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
    expect(setup.callbacks).toEqual(['evt:code:short-circuit']);
    expect(l0()).toHaveLength(0);
    expect(setup.receipts.count).toBe(0);
    expect(setup.receipts.get('evt:code:short-circuit')).toBeUndefined();
    expect(setup.reserved).toHaveLength(0);
    expect(existsSync(join(stateDir, 'qq-sessions.json'))).toBe(false);
  });

  it('群聊 @ 后的前导空格不阻断 code 短路', async () => {
    const setup = await startHook();

    const response = await postHook(
      setup.server,
      payload('evt:code:group-leading-space', ' code sessions', {
        source: { kind: 'group', id: String(GROUP_ID), groupName: '群' },
        sender: { qqId: OWNER, nickname: '主人' },
        isAtBot: true,
      }),
    );

    expect(response.status).toBe(200);
    expect(setup.callbacks).toEqual(['evt:code:group-leading-space']);
    expect(l0()).toHaveLength(0);
    expect(setup.receipts.count).toBe(0);
    expect(setup.reserved).toHaveLength(0);
  });

  it.each([
    [
      '群里普通成员',
      {
        source: { kind: 'group', id: String(GROUP_ID), groupName: '群' },
        sender: { qqId: '222333444', nickname: '成员' },
        isAtBot: true,
      },
    ],
    [
      'owner 群聊',
      {
        source: { kind: 'group', id: String(GROUP_ID), groupName: '群' },
        sender: { qqId: OWNER, nickname: '主人' },
        isAtBot: true,
      },
    ],
    [
      '陌生私聊',
      {
        source: { kind: 'private', id: '999000111', groupName: null },
        sender: { qqId: '999000111', nickname: '陌生人' },
      },
    ],
  ])('%s 的 code 仍短路回调，不落任何状态', async (_name, overrides) => {
    const setup = await startHook();

    const response = await postHook(
      setup.server,
      payload('evt:code:non-owner', 'code xtds 不应执行', overrides),
    );

    expect(response.status).toBe(200);
    expect(setup.callbacks).toHaveLength(1);
    expect(l0()).toHaveLength(0);
    expect(setup.receipts.count).toBe(0);
    expect(setup.reserved).toHaveLength(0);
  });

  it('黑名单 403 优先，不触发 code 回调', async () => {
    const setup = await startHook({ denyGroups: [GROUP_ID] });

    const response = await postHook(
      setup.server,
      payload('evt:code:denied', 'code xtds nope', {
        source: { kind: 'group', id: String(GROUP_ID), groupName: '群' },
        sender: { qqId: '222333444', nickname: '成员' },
        isAtBot: true,
      }),
    );

    expect(response.status).toBe(403);
    expect(setup.callbacks).toEqual([]);
    expect(l0()).toHaveLength(0);
    expect(setup.receipts.count).toBe(0);
    expect(setup.warnings).toEqual(['hook 权限拒绝：deny_group']);
  });

  it('无 callback 时也只 200 丢弃；callback 抛错不影响 200', async () => {
    const noCallback = await startHook({ onCodeCommand: null });
    const code = payload('evt:code:no-callback', 'code');
    expect((await postHook(noCallback.server, code)).status).toBe(200);
    expect(l0()).toHaveLength(0);
    expect(noCallback.receipts.count).toBe(0);

    const throwing = await startHook({
      onCodeCommand: () => {
        throw new Error('boom');
      },
    });
    expect(
      (
        await postHook(
          throwing.server,
          payload('evt:code:throws', 'code status'),
        )
      ).status,
    ).toBe(200);
    expect(throwing.warnings).toContain('code 命令回调失败');
  });

  it('codex / Code / 前置空格是普通消息，不被短路', async () => {
    const setup = await startHook();
    const variants = ['codex ds-memory task', 'Code ds-memory task', ' code ds-memory task'];

    for (const [index, text] of variants.entries()) {
      const response = await postHook(
        setup.server,
        payload(`evt:ordinary:${index}`, text),
      );
      expect(response.status).toBe(200);
    }

    expect(setup.callbacks).toEqual([]);
    expect(l0()).toHaveLength(3);
    expect(setup.reserved).toHaveLength(3);
  });
});

async function startGateway(): Promise<FakeGateway> {
  const requests: GatewayRequest[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/send') {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          target: QqTarget;
          messages: string[];
          reason?: string;
        };
        requests.push({
          target: body.target,
          messages: [...body.messages],
          reason: body.reason,
        });
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            ok: true,
            sent: body.messages.map((_message, index) => ({
              messageId: String(index + 1),
            })),
          }),
        );
        return;
      }
      if (req.method === 'GET' && req.url === '/health') {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true, online: true, selfQqId: '10001' }));
        return;
      }
      res.statusCode = 404;
      res.end('{"ok":false}');
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('假网关未取得端口');

  const gateway: FakeGateway = {
    port: address.port,
    requests,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  gateways.push(gateway);
  return gateway;
}

function serviceConfig(gateway: FakeGateway): AppConfig {
  const config = structuredClone(loadConfig(REPO_ROOT).config);
  config.stateDir = stateDir;
  config.qq.enabled = true;
  config.qq.hookPort = 0;
  config.qq.hookToken = TOKEN;
  config.qq.ownerQQ = OWNER_QQ;
  config.qq.allowGroups = [GROUP_ID];
  config.qq.gatewayUrl = `http://127.0.0.1:${gateway.port}`;
  config.qq.runtimeDir = runtimeDir;
  config.qq.batchWindowMs = 20;
  config.qq.healthIntervalMs = 60_000;
  config.codeBridge.enabled = true;
  config.codeBridge.pollIntervalMs = 20;
  return config;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('条件等待超时');
}

async function postServiceHook(
  service: QqService,
  body: unknown,
): Promise<TestResponse> {
  const response = await fetch(`http://127.0.0.1:${service.port}/hook/message`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-memory-token': TOKEN,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: JSON.parse(text) as unknown, text };
}

describe('QqService code command wiring', () => {
  it('提交 ack 走 reply、终态走 proactive，全程不写 L0/Receipt、不调 provider', async () => {
    const gateway = await startGateway();
    const bridge = new FakeBridge();
    const providerState = { calls: 0, texts: [] as string[] };
    const service = await startQqService({
      config: serviceConfig(gateway),
      persona: '测试',
      provider: providerSaying('不应回复', providerState),
      codeBridgeClient: bridge,
      onWarn: () => undefined,
      onInfo: () => undefined,
    });
    services.push(service);

    const response = await postServiceHook(
      service,
      payload('evt:code:service', 'code ds-memory 修复 QQ 接线'),
    );
    await waitUntil(() => gateway.requests.length === 1);

    expect(response.status).toBe(200);
    expect(bridge.submitCalls).toHaveLength(1);
    expect(gateway.requests[0]).toMatchObject({
      target: { kind: 'private', id: OWNER },
      reason: 'reply',
    });
    expect(gateway.requests[0]?.messages).toHaveLength(1);
    expect(gateway.requests[0]?.messages[0]).toContain('task-1');
    expect(gateway.requests[0]?.messages[0]).toContain('ds-memory');
    expect(gateway.requests[0]?.messages[0]).not.toContain(TOKEN);
    expect(l0()).toHaveLength(0);
    expect(service.receipts.count).toBe(0);
    expect(providerState.calls).toBe(0);

    bridge.current = task({
      taskId: 'task-1',
      requestId: 'evt:code:service',
      repo: 'ds-memory',
      status: 'succeeded',
      updatedAt: NOW + 1,
      summary: '修复完成',
    });
    await service.codeTaskManager?.pollOnce();
    await waitUntil(() => gateway.requests.length === 2);

    expect(gateway.requests[1]).toMatchObject({
      target: { kind: 'private', id: OWNER },
      reason: 'proactive',
    });
    expect(gateway.requests[1]?.messages).toHaveLength(1);
    expect(gateway.requests[1]?.messages[0]).toContain('succeeded');
    expect(l0()).toHaveLength(0);
    expect(service.receipts.count).toBe(0);
    expect(providerState.calls).toBe(0);
  });

  it('真实 envelope 经 CodeBridgeClient 到 manager：submit 被接受，timed_out 只通知一次', async () => {
    const gateway = await startGateway();
    const endpointFile = join(runtimeDir, 'code-bridge.endpoint.json');
    const tokenFile = join(runtimeDir, 'code-bridge.token');
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(tokenFile, 'client-only-test-token\n', 'utf8');
    writeFileSync(
      endpointFile,
      JSON.stringify({
        v: 1,
        name: 'code-bridge',
        host: '127.0.0.1',
        port: 43123,
        pid: process.pid,
      }),
      'utf8',
    );

    let terminal = false;
    const transportCalls: string[] = [];
    const fetchImpl: CodeBridgeFetch = async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      transportCalls.push(`${method} ${url.pathname}`);

      if (method === 'POST' && url.pathname === '/v1/tasks') {
        const body = JSON.parse(String(init?.body)) as {
          requestId: string;
          repo: string;
        };
        return new Response(
          JSON.stringify({
            ok: true,
            duplicate: false,
            task: wireTask({
              requestId: body.requestId,
              repo: body.repo,
              taskId: TRANSPORT_TASK_ID,
              mode: null,
            }),
          }),
          { status: 202, headers: { 'content-type': 'application/json' } },
        );
      }

      if (
        method === 'GET' &&
        url.pathname === `/v1/tasks/${TRANSPORT_TASK_ID}`
      ) {
        return new Response(
          JSON.stringify({
            ok: true,
            task: wireTask({
              status: terminal ? 'timed_out' : 'queued',
              error: terminal ? 'dsh_timeout' : null,
              timestamps: terminal
                ? wireTimestamps({
                    finishedAt: TRANSPORT_FINISHED_AT,
                    updatedAt: TRANSPORT_FINISHED_AT,
                  })
                : wireTimestamps(),
            }),
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }

      return new Response(JSON.stringify({ ok: false, error: 'not_found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    };

    const bridge = new CodeBridgeClient({
      endpointFile,
      tokenFile,
      fetchImpl,
      isPidAlive: () => true,
    });
    const service = await startQqService({
      config: serviceConfig(gateway),
      persona: '测试',
      provider: providerSaying('不应回复', { calls: 0, texts: [] }),
      codeBridgeClient: bridge,
      onWarn: () => undefined,
      onInfo: () => undefined,
    });
    services.push(service);

    const response = await postServiceHook(
      service,
      payload('evt:code:transport', 'code ds-memory 走真实 envelope'),
    );
    await waitUntil(() => gateway.requests.length === 1);

    expect(response.status).toBe(200);
    expect(transportCalls).toContain('POST /v1/tasks');
    expect(gateway.requests[0]).toMatchObject({
      target: { kind: 'private', id: OWNER },
      reason: 'reply',
    });
    expect(gateway.requests[0]?.messages[0]).toContain(TRANSPORT_TASK_ID);

    terminal = true;
    await service.codeTaskManager?.pollOnce();
    await waitUntil(() => gateway.requests.length === 2);

    expect(gateway.requests[1]).toMatchObject({
      target: { kind: 'private', id: OWNER },
      reason: 'proactive',
    });
    expect(gateway.requests[1]?.messages).toHaveLength(1);
    expect(gateway.requests[1]?.messages[0]).toContain('timed_out');

    await service.codeTaskManager?.pollOnce();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(gateway.requests).toHaveLength(2);

    const persisted = JSON.parse(
      readFileSync(join(stateDir, 'code-tasks.json'), 'utf8'),
    ) as { tasks: Array<{ taskId: string; status: string }> };
    expect(persisted.tasks).toEqual([
      expect.objectContaining({
        taskId: TRANSPORT_TASK_ID,
        status: 'timed_out',
        mode: null,
      }),
    ]);
    const reloaded = new CodeTaskStore({ stateDir });
    expect(reloaded.findByTaskId(TRANSPORT_TASK_ID)).toMatchObject({
      mode: null,
    });
  });

  it('owner 在白名单群 @ 发 code：提交任务，回执发到群', async () => {
    const gateway = await startGateway();
    const bridge = new FakeBridge();
    const service = await startQqService({
      config: serviceConfig(gateway),
      persona: '测试',
      provider: providerSaying('不应回复', { calls: 0, texts: [] }),
      codeBridgeClient: bridge,
      onWarn: () => undefined,
      onInfo: () => undefined,
    });
    services.push(service);

    const response = await postServiceHook(
      service,
      payload('evt:code:group', ' code xtds 不执行', {
        source: { kind: 'group', id: String(GROUP_ID), groupName: '群' },
        sender: { qqId: OWNER, nickname: '主人' },
        isAtBot: true,
      }),
    );
    await waitUntil(() => gateway.requests.length === 1);

    expect(response.status).toBe(200);
    expect(bridge.submitCalls).toHaveLength(1);
    expect(bridge.submitCalls[0]).toMatchObject({
      requestId: 'evt:code:group',
      repo: 'xtds',
      task: '不执行',
    });
    expect(gateway.requests[0]).toMatchObject({
      target: { kind: 'group', id: String(GROUP_ID) },
      reason: 'reply',
    });
    expect(gateway.requests[0]?.messages[0]).toContain('task-1');
    expect(l0()).toHaveLength(0);
    expect(service.receipts.count).toBe(0);
  });

  it('owner 群聊 @ code sessions：只查询会话，不提交任务', async () => {
    const gateway = await startGateway();
    const bridge = new FakeBridge();
    bridge.sessions.push({
      sessionId: 'session-12345678-abcd',
      title: '群聊目标会话',
      workspace: 'ds-memory',
      lastUsedAt: NOW,
      resumable: true,
    });
    const service = await startQqService({
      config: serviceConfig(gateway),
      persona: '测试',
      provider: providerSaying('不应回复', { calls: 0, texts: [] }),
      codeBridgeClient: bridge,
      onWarn: () => undefined,
      onInfo: () => undefined,
    });
    services.push(service);

    await postServiceHook(
      service,
      payload('evt:code:group:sessions', ' code sessions', {
        source: { kind: 'group', id: String(GROUP_ID), groupName: '群' },
        sender: { qqId: OWNER, nickname: '主人' },
        isAtBot: true,
      }),
    );
    await waitUntil(() => gateway.requests.length === 1);

    expect(bridge.submitCalls).toHaveLength(0);
    expect(gateway.requests[0]).toMatchObject({
      target: { kind: 'group', id: String(GROUP_ID) },
      reason: 'reply',
    });
    expect(gateway.requests[0]?.messages[0]).toContain('群聊目标会话');
    expect(l0()).toHaveLength(0);
    expect(service.receipts.count).toBe(0);
  });

  it('普通群友 @ 或 owner 未 @ 的 code 都静默丢弃', async () => {
    const gateway = await startGateway();
    const bridge = new FakeBridge();
    const service = await startQqService({
      config: serviceConfig(gateway),
      persona: '测试',
      provider: providerSaying('不应回复', { calls: 0, texts: [] }),
      codeBridgeClient: bridge,
      onWarn: () => undefined,
      onInfo: () => undefined,
    });
    services.push(service);

    await postServiceHook(
      service,
      payload('evt:code:member', 'code sessions', {
        source: { kind: 'group', id: String(GROUP_ID), groupName: '群' },
        sender: { qqId: '222333444', nickname: '成员' },
        isAtBot: true,
      }),
    );
    await postServiceHook(
      service,
      payload('evt:code:owner-no-mention', 'code status', {
        source: { kind: 'group', id: String(GROUP_ID), groupName: '群' },
        sender: { qqId: OWNER, nickname: '主人' },
        isAtBot: false,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(bridge.submitCalls).toHaveLength(0);
    expect(gateway.requests).toHaveLength(0);
    expect(l0()).toHaveLength(0);
    expect(service.receipts.count).toBe(0);
  });

  it('代码工具只注入 live owner 私聊；群聊与伪造 sender 不注入', async () => {
    const gateway = await startGateway();
    const bridge = new FakeBridge();
    const counter = { calls: 0, tools: [] as string[][] };
    const service = await startQqService({
      config: serviceConfig(gateway),
      persona: '测试',
      provider: providerRecordingTools(counter),
      codeBridgeClient: bridge,
      onWarn: () => undefined,
      onInfo: () => undefined,
    });
    services.push(service);

    await postServiceHook(
      service,
      payload('evt:code-tools:owner', '帮我改一下 ds-memory 的代码'),
    );
    await service.waitForIdle();
    expect(counter.tools[0]).toEqual(
      expect.arrayContaining(['code_sessions', 'code_task', 'code_status']),
    );

    await postServiceHook(
      service,
      payload('evt:code-tools:group', '帮我改一下代码', {
        source: { kind: 'group', id: String(GROUP_ID), groupName: '群' },
        sender: { qqId: OWNER, nickname: '主人' },
        isAtBot: true,
      }),
    );
    await service.waitForIdle();
    expect(counter.tools[1]).not.toContain('code_task');

    await postServiceHook(
      service,
      payload('evt:code-tools:forged', '帮我改一下代码', {
        sender: { qqId: '999000111', nickname: '伪造者' },
      }),
    );
    await service.waitForIdle();
    expect(counter.tools[2]).not.toContain('code_task');
    expect(bridge.submitCalls).toHaveLength(0);
  });

  it('recovered owner 私聊不注入代码工具', async () => {
    const gateway = await startGateway();
    const store = new EventStore({
      dir: memoryEventsDir(stateDir),
      now: () => NOW,
      onWarn: () => undefined,
    });
    const receipts = new ReceiptStore({
      dir: join(stateDir, 'qq'),
      store,
      now: () => NOW,
      onWarn: () => undefined,
    });
    receipts.reserve({
      eventId: 'evt:code-tools:recovered',
      sessionKey: `private:${OWNER}`,
      role: 'user',
      text: '恢复的 owner 私聊',
      speaker: null,
      quote: null,
      isAtBot: false,
      senderQqId: OWNER,
      modelEligible: true,
      at: NOW,
    });
    const counter = { calls: 0, tools: [] as string[][] };
    const service = await startQqService({
      config: serviceConfig(gateway),
      persona: '测试',
      provider: providerRecordingTools(counter),
      codeBridgeClient: new FakeBridge(),
      store,
      receipts,
      onWarn: () => undefined,
      onInfo: () => undefined,
    });
    services.push(service);

    await service.waitForIdle();

    expect(service.recoveredCount).toBe(1);
    expect(counter.calls).toBe(1);
    expect(counter.tools[0]).not.toContain('code_task');
  });
});
