import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EventStore,
  type AppendInput,
  type AppendResult,
  type RawRecord,
} from '../../src/memory/store.ts';
import {
  endpointPath,
  parseEndpoint,
  type EndpointInfo,
} from '../../src/qq/endpoint.ts';
import {
  HookServer,
  type ReservedHookEvent,
} from '../../src/qq/hooks.ts';
import {
  ReceiptStore,
  receiptsLogPath,
} from '../../src/qq/receipts.ts';
import { SessionMap } from '../../src/qq/session-map.ts';
import type { Receipt } from '../../src/qq/types.ts';

const NOW = 1_700_000_000_000;
const TOKEN = '0123456789abcdef0123456789abcdef0123456789abcdef';
const OWNER_QQ = 123456789;
const ALLOW_GROUP = 555000111;

const HOOK_FIXTURE_DIR = fileURLToPath(new URL('../contract/hook/', import.meta.url));
const ENDPOINT_FIXTURE_DIR = fileURLToPath(
  new URL('../contract/endpoint/', import.meta.url),
);

interface HookFixture {
  name: string;
  payload: unknown;
  expect: { status: number; body?: unknown };
}

interface TestResponse {
  status: number;
  body: unknown;
  text: string;
}

interface StartOptions {
  ownerQQ?: number;
  allowGroups?: number[];
  denyPrivate?: number[];
  denyGroups?: number[];
  allowGroupMemberReply?: boolean;
  groupWake?: 'mention' | 'all';
  port?: number;
  eventStore?: EventStore;
  onReserved?: (reserved: ReservedHookEvent) => void;
  statusProvider?: () => Record<string, unknown>;
  instanceId?: string;
  pid?: number;
}

interface HookSetup {
  server: HookServer;
  store: EventStore;
  receipts: ReceiptStore;
  sessionMap: SessionMap;
  reserved: ReservedHookEvent[];
}

class PathLeakWriteErrorStore extends EventStore {
  override appendResult(_input: AppendInput): AppendResult {
    return {
      kind: 'write_error',
      message: 'C:\\private\\events\\2026-11.jsonl /tmp/private/events.jsonl',
    };
  }
}

class InvalidTimeDuplicateStore extends EventStore {
  override appendResult(input: AppendInput): AppendResult {
    return {
      kind: 'duplicate',
      record: {
        id: input.id ?? '',
        src: 'qq',
        sessionKey: 'private:123456789',
        t: 'not-a-date',
        role: 'user',
        text: input.text,
      },
    };
  }
}

let rootDir: string;
let stateDir: string;
let eventsDir: string;
let receiptDir: string;
let runtimeDir: string;
let clock: number;
let storeWarnings: string[];
let receiptWarnings: string[];
let sessionWarnings: string[];
let hookWarnings: string[];
let servers: HookServer[];
let auxiliaryServers: Server[];
let eventSeq: number;

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'xds-hooks-'));
  stateDir = join(rootDir, 'state');
  eventsDir = join(stateDir, 'memory', 'events');
  receiptDir = join(stateDir, 'qq');
  runtimeDir = join(rootDir, 'runtime');
  clock = NOW;
  storeWarnings = [];
  receiptWarnings = [];
  sessionWarnings = [];
  hookWarnings = [];
  servers = [];
  auxiliaryServers = [];
  eventSeq = 0;
});

afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()!.stop();
  }
  for (const server of auxiliaryServers) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  rmSync(rootDir, { recursive: true, force: true });
});

function newEventStore(): EventStore {
  return new EventStore({
    dir: eventsDir,
    now: () => clock,
    onWarn: (message) => storeWarnings.push(message),
  });
}

async function startHook(options: StartOptions = {}): Promise<HookSetup> {
  const store = options.eventStore ?? newEventStore();
  const receipts = new ReceiptStore({
    dir: receiptDir,
    store,
    now: () => clock,
    onWarn: (message) => receiptWarnings.push(message),
  });
  const sessionMap = new SessionMap({
    stateDir,
    ownerQQ: options.ownerQQ ?? OWNER_QQ,
    allowGroups: options.allowGroups ?? [ALLOW_GROUP],
    denyPrivate: options.denyPrivate ?? [],
    denyGroups: options.denyGroups ?? [],
    allowGroupMemberReply: options.allowGroupMemberReply,
    groupWake: options.groupWake,
    now: () => clock,
    onWarn: (message) => sessionWarnings.push(message),
  });
  const reserved: ReservedHookEvent[] = [];
  const server = new HookServer({
    port: options.port ?? 0,
    token: TOKEN,
    runtimeDir,
    receipts,
    sessionMap,
    now: () => clock,
    onWarn: (message) => hookWarnings.push(message),
    instanceId: options.instanceId ?? 'test-instance',
    pid: options.pid ?? process.pid,
    onReserved:
      options.onReserved ??
      ((item) => {
        reserved.push(item);
      }),
    statusProvider: options.statusProvider,
  });
  await server.start();
  servers.push(server);
  return { server, store, receipts, sessionMap, reserved };
}

function baseUrl(server: HookServer): string {
  return `http://127.0.0.1:${server.port}`;
}

async function request(
  server: HookServer,
  path: string,
  init: RequestInit = {},
): Promise<TestResponse> {
  const response = await fetch(`${baseUrl(server)}${path}`, init);
  const text = await response.text();
  let body: unknown = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: response.status, body, text };
}

async function postHook(
  server: HookServer,
  payload: unknown,
  token: string | null = TOKEN,
): Promise<TestResponse> {
  return postRaw(server, JSON.stringify(payload), token);
}

async function postRaw(
  server: HookServer,
  body: string,
  token: string | null = TOKEN,
): Promise<TestResponse> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (token !== null) headers['x-memory-token'] = token;
  return request(server, '/hook/message', {
    method: 'POST',
    headers,
    body,
  });
}

function messagePayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  eventSeq += 1;
  return {
    v: 1,
    eventId: `evt:test:message:${eventSeq}`,
    at: NOW,
    source: {
      kind: 'private',
      id: String(OWNER_QQ),
      groupName: null,
    },
    sender: {
      qqId: '987654321',
      nickname: '小鲸鱼他爹',
    },
    messageId: String(eventSeq),
    text: '在吗',
    isAtBot: false,
    quote: null,
    media: [],
    poke: null,
    ...overrides,
  };
}

function groupSource(): Record<string, unknown> {
  return {
    kind: 'group',
    id: String(ALLOW_GROUP),
    groupName: '三人小群',
  };
}

function allL0(): RawRecord[] {
  const disk = new EventStore({ dir: eventsDir, onWarn: () => undefined });
  return disk.listMonths().flatMap((month) => disk.readMonth(month));
}

function receiptLines(): Array<{ v: number; receipt: Receipt }> {
  if (!existsSync(receiptsLogPath(receiptDir))) return [];
  return readFileSync(receiptsLogPath(receiptDir), 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { v: number; receipt: Receipt });
}

function sessionsFile(): {
  v: number;
  sessions: Array<{
    sessionKey: string;
    messageCount: number;
    groupName: string | null;
  }>;
} | null {
  const path = join(stateDir, 'qq-sessions.json');
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as {
    v: number;
    sessions: Array<{
      sessionKey: string;
      messageCount: number;
      groupName: string | null;
    }>;
  };
}

function hookFixtures(): HookFixture[] {
  return readdirSync(HOOK_FIXTURE_DIR)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map(
      (name) =>
        JSON.parse(readFileSync(join(HOOK_FIXTURE_DIR, name), 'utf8')) as HookFixture,
    );
}

function assertNoSecretOrPath(text: string, payloadText?: string): void {
  expect(text).not.toContain(TOKEN);
  expect(text).not.toContain('C:\\');
  expect(text).not.toContain('/tmp');
  if (payloadText !== undefined) expect(text).not.toContain(payloadText);
}

describe('GET /health', () => {
  it('免 token 返回固定健康信息，且不泄漏 token', async () => {
    const setup = await startHook();

    const response = await request(setup.server, '/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      name: 'ds-memory',
      version: '0.2.0',
      ok: true,
      hookPort: setup.server.port,
    });
    assertNoSecretOrPath(response.text);
  });

  it('未知路由返回 404', async () => {
    const setup = await startHook();
    expect((await request(setup.server, '/nope')).status).toBe(404);
  });
});

describe('GET /status', () => {
  it('缺失或错误 token 均返回 401，且不返回状态内容', async () => {
    const setup = await startHook();

    const missing = await request(setup.server, '/status');
    const wrong = await request(setup.server, '/status', {
      headers: { 'x-memory-token': 'wrong-token' },
    });

    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(missing.body).toEqual({ ok: false });
    expect(wrong.body).toEqual({ ok: false });
    assertNoSecretOrPath(missing.text);
    assertNoSecretOrPath(wrong.text);
  });

  it('正确 token 返回固定字段，且不泄漏 token/正文/路径', async () => {
    const setup = await startHook();
    const payload = messagePayload({ eventId: 'evt:status-visible', text: '机密正文' });
    await postHook(setup.server, payload);

    const response = await request(setup.server, '/status', {
      headers: { 'x-memory-token': TOKEN },
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
      pid: process.pid,
      hookPort: setup.server.port,
      gateway: 'unknown',
      sessions: 1,
      receipts: 1,
      inbox: { pending: 0, busy: 0 },
      recovered: 0,
      aborted: 0,
    });
    expect(typeof (response.body as { uptimeMs?: unknown }).uptimeMs).toBe('number');
    assertNoSecretOrPath(response.text, '机密正文');
    expect(response.text).not.toContain(String(ALLOW_GROUP));
  });

  it('status provider 抛错时返回 500 固定响应，不透出异常 message', async () => {
    const setup = await startHook({
      statusProvider: () => {
        throw new Error(`C:\\private\\state.json ${TOKEN} 机密正文`);
      },
    });

    const response = await request(setup.server, '/status', {
      headers: { 'x-memory-token': TOKEN },
    });

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ ok: false });
    assertNoSecretOrPath(response.text, '机密正文');
    expect(response.text).not.toContain('private');
    expect(hookWarnings).toEqual(['status provider 失败']);
  });
});

describe('POST /hook/message authentication and shape', () => {
  it('缺失或错误 token 均返回 401，且零副作用', async () => {
    const setup = await startHook();
    const payload = messagePayload();

    const missing = await postHook(setup.server, payload, null);
    const wrong = await postHook(setup.server, payload, 'wrong-token');

    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(missing.body).toEqual({ ok: false });
    expect(wrong.body).toEqual({ ok: false });
    assertNoSecretOrPath(missing.text, String(payload.text));
    assertNoSecretOrPath(wrong.text, String(payload.text));
    expect(allL0()).toHaveLength(0);
    expect(receiptLines()).toHaveLength(0);
    expect(sessionsFile()).toBeNull();
    expect(setup.reserved).toHaveLength(0);
  });

  it('非法 JSON 与错误 v 返回 400，且零副作用', async () => {
    const setup = await startHook();

    expect((await postRaw(setup.server, '{broken')).status).toBe(400);
    expect(
      (await postHook(setup.server, messagePayload({ v: 2 }))).status,
    ).toBe(400);

    expect(allL0()).toHaveLength(0);
    expect(sessionsFile()).toBeNull();
    expect(setup.reserved).toHaveLength(0);
  });

  it.each(hookFixtures().map((fixture) => [fixture.name, fixture] as const))(
    '契约 fixture %s',
    async (_name, fixture) => {
      const setup = await startHook();

      const response = await postHook(setup.server, fixture.payload);

      expect(response.status).toBe(fixture.expect.status);
      if (fixture.expect.body !== undefined) {
        expect(response.body).toEqual(fixture.expect.body);
      }
      if (fixture.expect.status !== 200) {
        expect(allL0()).toHaveLength(0);
        expect(receiptLines()).toHaveLength(0);
        expect(sessionsFile()).toBeNull();
        expect(setup.reserved).toHaveLength(0);
      } else {
        expect(response.body).toEqual({ ok: true });
      }
    },
  );

  it('超过 64KB 的请求返回 413，且不落 L0/Receipt/会话', async () => {
    const setup = await startHook();
    const payload = messagePayload({ text: 'x'.repeat(70 * 1024) });

    const response = await postHook(setup.server, payload);

    expect(response.status).toBe(413);
    expect(response.body).toEqual({ ok: false });
    expect(allL0()).toHaveLength(0);
    expect(receiptLines()).toHaveLength(0);
    expect(sessionsFile()).toBeNull();
    expect(setup.reserved).toHaveLength(0);
  });
});

describe('POST /hook/message permissions', () => {
  it('denyPrivate 与 denyGroups 返回 403，且不落任何状态', async () => {
    const setup = await startHook({
      denyPrivate: [OWNER_QQ],
      denyGroups: [ALLOW_GROUP],
    });
    const privatePayload = messagePayload();
    const groupPayload = messagePayload({
      source: groupSource(),
      isAtBot: true,
    });

    const privateResponse = await postHook(setup.server, privatePayload);
    const groupResponse = await postHook(setup.server, groupPayload);

    expect(privateResponse.status).toBe(403);
    expect(groupResponse.status).toBe(403);
    expect(privateResponse.body).toEqual({ ok: false });
    expect(groupResponse.body).toEqual({ ok: false });
    assertNoSecretOrPath(privateResponse.text, String(privatePayload.text));
    assertNoSecretOrPath(groupResponse.text, String(groupPayload.text));
    expect(allL0()).toHaveLength(0);
    expect(receiptLines()).toHaveLength(0);
    expect(sessionsFile()).toBeNull();
    expect(setup.reserved).toHaveLength(0);
    expect(hookWarnings).toEqual([
      'hook 权限拒绝：deny_private',
      'hook 权限拒绝：deny_group',
    ]);
  });

  it('陌生私聊与非白名单群静默 200，且不落任何状态', async () => {
    const setup = await startHook();
    const stranger = messagePayload({
      source: { kind: 'private', id: '30003', groupName: null },
    });
    const strangerGroup = messagePayload({
      source: { kind: 'group', id: '60000', groupName: '陌生群' },
    });

    const a = await postHook(setup.server, stranger);
    const b = await postHook(setup.server, strangerGroup);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body).toEqual({ ok: true });
    expect(b.body).toEqual({ ok: true });
    expect(allL0()).toHaveLength(0);
    expect(receiptLines()).toHaveLength(0);
    expect(sessionsFile()).toBeNull();
    expect(setup.reserved).toHaveLength(0);
    expect(hookWarnings).toEqual([]);
  });
});

describe('POST /hook/message persistence', () => {
  it('合法私聊 200：写 L0、Receipt、会话，并把私聊 speaker 置 null', async () => {
    const setup = await startHook();
    const payload = messagePayload({ eventId: 'evt:private:ok' });

    const response = await postHook(setup.server, payload);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
    expect(allL0()).toEqual([
      {
        id: 'evt:private:ok',
        src: 'qq',
        sessionKey: `private:${OWNER_QQ}`,
        t: new Date(NOW).toISOString(),
        role: 'user',
        text: '在吗',
        speaker: null,
        quote: null,
        isAtBot: false,
        senderQqId: '987654321',
        modelEligible: true,
      },
    ]);
    expect(receiptLines()).toHaveLength(1);
    expect(receiptLines()[0]?.receipt).toMatchObject({
      eventId: 'evt:private:ok',
      sessionKey: `private:${OWNER_QQ}`,
      status: 'received',
    });
    expect(sessionsFile()).toMatchObject({
      v: 1,
      sessions: [
        {
          sessionKey: `private:${OWNER_QQ}`,
          messageCount: 1,
          groupName: null,
        },
      ],
    });
    expect(setup.reserved).toHaveLength(1);
    expect(setup.reserved[0]).toMatchObject({
      sessionKey: `private:${OWNER_QQ}`,
      receipt: { eventId: 'evt:private:ok', status: 'received' },
    });
  });

  it('非 owner 群消息 200：完整原文持久化 + stored_only，不触发入队', async () => {
    const setup = await startHook();
    const payload = messagePayload({
      eventId: 'evt:group:ok',
      source: groupSource(),
      sender: { qqId: '222333444', nickname: '张三' },
      text: '@小鲸鱼 帮我看下 4090',
      isAtBot: true,
      quote: { fromName: '李四', text: '上次说的 4090' },
    });

    const response = await postHook(setup.server, payload);

    expect(response.status).toBe(200);
    expect(allL0()[0]).toMatchObject({
      sessionKey: `group:${ALLOW_GROUP}`,
      text: '@小鲸鱼 帮我看下 4090',
      speaker: '张三',
      quote: { fromName: '李四', text: '上次说的 4090' },
      isAtBot: true,
      senderQqId: '222333444',
      modelEligible: false,
    });
    expect(sessionsFile()).toMatchObject({
      sessions: [
        {
          sessionKey: `group:${ALLOW_GROUP}`,
          messageCount: 1,
          groupName: '三人小群',
        },
      ],
    });
    expect(setup.reserved).toHaveLength(0);
    expect(setup.receipts.get('evt:group:ok')).toMatchObject({
      status: 'done',
      outcome: 'stored_only',
    });
  });

  it('开启成员回复后：普通群友 @ 可入队，非 @ 仍 stored_only', async () => {
    const setup = await startHook({ allowGroupMemberReply: true });

    const mention = messagePayload({
      eventId: 'evt:group:member-mention',
      source: groupSource(),
      sender: { qqId: '222333444', nickname: '张三' },
      text: '@小鲸鱼 帮我看下',
      isAtBot: true,
    });
    expect((await postHook(setup.server, mention)).status).toBe(200);

    const plain = messagePayload({
      eventId: 'evt:group:member-plain',
      source: groupSource(),
      sender: { qqId: '222333444', nickname: '张三' },
      text: '普通群聊',
      isAtBot: false,
    });
    expect((await postHook(setup.server, plain)).status).toBe(200);

    expect(setup.reserved.map((item) => item.receipt.eventId)).toEqual([
      'evt:group:member-mention',
    ]);
    expect(setup.receipts.get('evt:group:member-mention')).toMatchObject({
      status: 'received',
    });
    expect(setup.receipts.get('evt:group:member-plain')).toMatchObject({
      status: 'done',
      outcome: 'stored_only',
    });

    const records = allL0();
    expect(records.find((record) => record.id === 'evt:group:member-mention')).toMatchObject({
      senderQqId: '222333444',
      modelEligible: true,
    });
    expect(records.find((record) => record.id === 'evt:group:member-plain')).toMatchObject({
      senderQqId: '222333444',
      modelEligible: false,
    });
  });

  it('owner 群消息 @ 可入队：modelEligible=true 且 Receipt 保持 received', async () => {
    const setup = await startHook();
    const payload = messagePayload({
      eventId: 'evt:group:owner',
      source: groupSource(),
      sender: { qqId: String(OWNER_QQ), nickname: '主人' },
      text: '@小鲸鱼 只应 owner 唤醒',
      isAtBot: true,
    });

    const response = await postHook(setup.server, payload);

    expect(response.status).toBe(200);
    expect(allL0()[0]).toMatchObject({
      sessionKey: `group:${ALLOW_GROUP}`,
      text: '@小鲸鱼 只应 owner 唤醒',
      senderQqId: String(OWNER_QQ),
      modelEligible: true,
    });
    expect(setup.reserved).toHaveLength(1);
    expect(setup.reserved[0]).toMatchObject({
      sessionKey: `group:${ALLOW_GROUP}`,
      receipt: { eventId: 'evt:group:owner', status: 'received' },
    });
  });

  it('并发重复 eventId 仅产生一个 new；跨重启仍为零副作用 duplicate', async () => {
    const setup = await startHook();
    const payload = messagePayload({ eventId: 'evt:concurrent' });

    const responses = await Promise.all([
      postHook(setup.server, payload),
      postHook(setup.server, payload),
      postHook(setup.server, payload),
    ]);

    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    expect(allL0()).toHaveLength(1);
    expect(receiptLines()).toHaveLength(1);
    expect(setup.reserved).toHaveLength(1);
    expect(sessionsFile()?.sessions[0]?.messageCount).toBe(1);

    await setup.server.stop();
    const restarted = await startHook();
    const duplicate = await postHook(restarted.server, payload);

    expect(duplicate.status).toBe(200);
    expect(allL0()).toHaveLength(1);
    expect(receiptLines()).toHaveLength(1);
    expect(restarted.reserved).toHaveLength(0);
    expect(sessionsFile()?.sessions[0]?.messageCount).toBe(1);
  });

  it('运行时 L0 已存在但 Receipt 缺失：补建一次并恢复入队，不重写 L0', async () => {
    const setup = await startHook();
    const payload = messagePayload({
      eventId: 'evt:l0-only',
      text: '请求里的不同正文',
    });
    expect(
      setup.store.appendResult({
        id: 'evt:l0-only',
        src: 'qq',
        sessionKey: `private:${OWNER_QQ}`,
        role: 'user',
        text: '已有 L0 原文',
        t: NOW + 1,
      }).kind,
    ).toBe('inserted');

    const response = await postHook(setup.server, payload);

    expect(response.status).toBe(200);
    expect(allL0()).toHaveLength(1);
    expect(allL0()[0]?.text).toBe('已有 L0 原文');
    expect(receiptLines()).toHaveLength(1);
    expect(setup.reserved).toHaveLength(1);
    expect(setup.receipts.get('evt:l0-only')).toMatchObject({
      status: 'received',
      sessionKey: `private:${OWNER_QQ}`,
    });
  });

  it('运行时既有 L0 为 CLI：返回 200 ignored，零 Receipt/会话/入队', async () => {
    const setup = await startHook();
    const payload = messagePayload({ eventId: 'evt:cli-only' });
    expect(
      setup.store.appendResult({
        id: 'evt:cli-only',
        src: 'cli',
        sessionKey: 'cli:default',
        role: 'user',
        text: 'CLI 记录',
        t: NOW + 1,
      }).kind,
    ).toBe('inserted');

    const response = await postHook(setup.server, payload);

    expect(response.status).toBe(200);
    expect(allL0()).toHaveLength(1);
    expect(receiptLines()).toHaveLength(0);
    expect(sessionsFile()).toBeNull();
    expect(setup.reserved).toHaveLength(0);
    expect(setup.receipts.get('evt:cli-only')).toBeUndefined();
  });

  it('运行时既有 QQ L0 早于 receiptsSince：返回 200 ignored', async () => {
    const setup = await startHook();
    expect(setup.receipts.receiptsSince).toBe(NOW);
    expect(
      setup.store.appendResult({
        id: 'evt:before-since',
        src: 'qq',
        sessionKey: `private:${OWNER_QQ}`,
        role: 'user',
        text: '水位前旧消息',
        t: NOW - 1,
      }).kind,
    ).toBe('inserted');

    const response = await postHook(
      setup.server,
      messagePayload({ eventId: 'evt:before-since' }),
    );

    expect(response.status).toBe(200);
    expect(allL0()).toHaveLength(1);
    expect(receiptLines()).toHaveLength(0);
    expect(sessionsFile()).toBeNull();
    expect(setup.reserved).toHaveLength(0);
  });

  it('既有 duplicate L0 的 t 无法解析时返回 503，不 ACK 不确定状态', async () => {
    const setup = await startHook({
      eventStore: new InvalidTimeDuplicateStore({
        dir: eventsDir,
        onWarn: (message) => storeWarnings.push(message),
      }),
    });
    const payload = messagePayload({ eventId: 'evt:bad-time', text: '机密正文' });

    const response = await postHook(setup.server, payload);

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ ok: false });
    assertNoSecretOrPath(response.text, '机密正文');
    expect(hookWarnings).toEqual(['hook 持久化失败：invalid_l0_record']);
    expect(setup.reserved).toHaveLength(0);
    expect(sessionsFile()).toBeNull();
  });

  it('L0 write_error 503：响应与日志均不泄漏 Windows/POSIX 路径', async () => {
    const setup = await startHook({
      eventStore: new PathLeakWriteErrorStore({
        dir: eventsDir,
        onWarn: (message) => storeWarnings.push(message),
      }),
    });
    const payload = messagePayload({ eventId: 'evt:write-error', text: '机密正文' });

    const response = await postHook(setup.server, payload);
    const status = await request(setup.server, '/status');

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ ok: false });
    assertNoSecretOrPath(response.text, '机密正文');
    assertNoSecretOrPath(hookWarnings.join('\n'), '机密正文');
    assertNoSecretOrPath(status.text, '机密正文');
    expect(hookWarnings).toEqual(['hook 持久化失败：l0_write_failed']);
    expect(setup.receipts.get('evt:write-error')).toBeUndefined();
    expect(setup.reserved).toHaveLength(0);
    expect(sessionsFile()).toBeNull();
  });

  it('Receipt 写失败先 503；重试补建 Receipt 后 200 且不重写 L0', async () => {
    const setup = await startHook();
    expect(setup.receipts.receiptsSince).toBe(NOW);
    mkdirSync(receiptsLogPath(receiptDir), { recursive: true });
    const payload = messagePayload({ eventId: 'evt:receipt-write-error' });

    const failed = await postHook(setup.server, payload);
    expect(failed.status).toBe(503);
    expect(failed.body).toEqual({ ok: false });
    expect(allL0()).toHaveLength(1);
    expect(setup.reserved).toHaveLength(0);
    expect(hookWarnings).toEqual(['hook 持久化失败：receipt_write_failed']);
    assertNoSecretOrPath(hookWarnings.join('\n'), String(payload.text));

    rmSync(receiptsLogPath(receiptDir), { recursive: true, force: true });
    const retried = await postHook(setup.server, payload);

    expect(retried.status).toBe(200);
    expect(allL0()).toHaveLength(1);
    expect(receiptLines()).toHaveLength(1);
    expect(setup.reserved).toHaveLength(1);
  });
});

describe('endpoint publication', () => {
  it('监听成功后原子写端点，内容不含 token；正常关闭删除本实例文件', async () => {
    const setup = await startHook({ instanceId: 'instance-alpha' });
    const filePath = endpointPath(runtimeDir, 'ds-memory');
    expect(existsSync(filePath)).toBe(true);

    const endpoint = JSON.parse(readFileSync(filePath, 'utf8')) as EndpointInfo;
    expect(endpoint).toEqual({
      v: 1,
      name: 'ds-memory',
      host: '127.0.0.1',
      port: setup.server.port,
      pid: process.pid,
      startedAt: NOW,
      instanceId: 'instance-alpha',
    });
    expect(Object.keys(endpoint).sort()).toEqual([
      'host',
      'instanceId',
      'name',
      'pid',
      'port',
      'startedAt',
      'v',
    ]);
    assertNoSecretOrPath(readFileSync(filePath, 'utf8'));
    expect(readdirSync(runtimeDir).filter((name) => name.includes('.tmp'))).toEqual([]);

    await setup.server.stop();
    expect(existsSync(filePath)).toBe(false);
  });

  it('instanceId 不匹配时关闭不删除他实例端点文件', async () => {
    const setup = await startHook({ instanceId: 'instance-alpha' });
    const filePath = endpointPath(runtimeDir, 'ds-memory');
    const endpoint = JSON.parse(readFileSync(filePath, 'utf8')) as EndpointInfo;
    writeFileSync(
      filePath,
      `${JSON.stringify({ ...endpoint, instanceId: 'instance-beta' })}\n`,
      'utf8',
    );

    await setup.server.stop();

    expect(existsSync(filePath)).toBe(true);
    expect((JSON.parse(readFileSync(filePath, 'utf8')) as EndpointInfo).instanceId).toBe(
      'instance-beta',
    );
  });

  it.each([
    ['valid-ds-memory.json', true, null],
    ['valid-qq-gateway.json', true, null],
    ['invalid-dead-pid.json', false, 'pid_dead'],
    ['invalid-missing-fields.json', false, 'missing_fields'],
    ['invalid-non-loopback.json', false, 'non_loopback_host'],
    ['invalid-port.json', false, 'port_out_of_range'],
    ['invalid-types.json', false, 'invalid_types'],
  ])('契约端点 fixture %s', (name, valid, reason) => {
    const fixture = JSON.parse(
      readFileSync(join(ENDPOINT_FIXTURE_DIR, name), 'utf8'),
    ) as { payload: unknown };

    const result = parseEndpoint(fixture.payload, {
      pidAlive: name !== 'invalid-dead-pid.json' ? () => true : () => false,
    });

    expect(result.valid).toBe(valid);
    if (!result.valid) expect(result.reason).toBe(reason);
  });

  it('首选端口 EADDRINUSE 时回退系统端口并 warn', async () => {
    const blocker = createServer((_req, res) => {
      res.statusCode = 200;
      res.end('occupied');
    });
    blocker.listen(0, '127.0.0.1');
    await once(blocker, 'listening');
    auxiliaryServers.push(blocker);
    const address = blocker.address();
    if (!address || typeof address === 'string') {
      throw new Error('阻塞服务未获得端口');
    }

    const setup = await startHook({ port: address.port });

    expect(setup.server.port).toBeGreaterThan(0);
    expect(setup.server.port).not.toBe(address.port);
    expect(
      hookWarnings.some(
        (message) =>
          message.includes(String(address.port)) &&
          message.includes('EADDRINUSE'),
      ),
    ).toBe(true);
    assertNoSecretOrPath(hookWarnings.join('\n'));

    const health = await request(setup.server, '/health');
    expect(health.body).toMatchObject({ hookPort: setup.server.port });
    expect(existsSync(endpointPath(runtimeDir, 'ds-memory'))).toBe(true);
  });
});
