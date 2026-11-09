import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Agent } from '../../src/agent/loop.ts';
import { loadConfig, type AppConfig } from '../../src/config/load.ts';
import { FactsStore } from '../../src/memory/facts.ts';
import { EventStore } from '../../src/memory/store.ts';
import { SelfNoteStore } from '../../src/memory/selfnote.ts';
import {
  usageOfEvent,
  type ChatEvent,
  type ChatEventStream,
  type ChatRequest,
  type Provider,
  type ToolCall,
} from '../../src/provider/types.ts';
import { AgentRegistry } from '../../src/qq/agent-registry.ts';
import { ReceiptStore } from '../../src/qq/receipts.ts';
import {
  startQqService,
  type QqService,
} from '../../src/qq/service.ts';
import { runQqTurn } from '../../src/qq/turn.ts';
import type {
  QqSender,
  QqTarget,
  ReceiptStore as QqReceiptStore,
  SendResult,
  WakePacket,
} from '../../src/qq/types.ts';
import {
  memoryEventsDir,
  memoryFactsDir,
  memorySelfNotesDir,
} from '../../src/state/paths.ts';
import type { AgentWebToolRuntime } from '../../src/tools/web/index.ts';

const NOW = 1_700_000_000_000;
const TOKEN = '0123456789abcdef0123456789abcdef0123456789abcdef';
const OWNER_QQ = 123456789;
const GROUP_ID = 555000111;
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

interface GatewayRequest {
  target: QqTarget;
  messages: string[];
}

interface FakeGateway {
  port: number;
  requests: GatewayRequest[];
  close(): Promise<void>;
}

interface ProviderStep {
  text?: string;
  toolCalls?: ToolCall[];
}

interface RecordingProvider {
  provider: Provider;
  requests: ChatRequest[];
}

let rootDir: string;
let stateDir: string;
let runtimeDir: string;
let gateways: FakeGateway[];
let services: QqService[];
let eventSeq: number;

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'xds-qq-websearch-'));
  stateDir = join(rootDir, 'state');
  runtimeDir = join(rootDir, 'runtime');
  gateways = [];
  services = [];
  eventSeq = 0;
});

afterEach(async () => {
  while (services.length > 0) {
    await services.pop()!.stop();
  }
  while (gateways.length > 0) {
    await gateways.pop()!.close();
  }
  rmSync(rootDir, { recursive: true, force: true });
});

async function startGateway(): Promise<FakeGateway> {
  const requests: GatewayRequest[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      if (req.method === 'GET' && req.url === '/health') {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true, online: true, selfQqId: '10001' }));
        return;
      }

      if (req.method === 'POST' && req.url === '/send') {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          target: QqTarget;
          messages: string[];
        };
        requests.push({ target: body.target, messages: [...body.messages] });
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

function baseConfig(gatewayUrl: string): AppConfig {
  const config = structuredClone(loadConfig(REPO_ROOT).config);
  config.stateDir = stateDir;
  config.qq.enabled = true;
  config.qq.hookPort = 0;
  config.qq.hookToken = TOKEN;
  config.qq.ownerQQ = OWNER_QQ;
  config.qq.allowGroups = [GROUP_ID];
  config.qq.gatewayUrl = gatewayUrl;
  config.qq.runtimeDir = runtimeDir;
  config.qq.batchWindowMs = 20;
  config.qq.healthIntervalMs = 60_000;
  config.qq.send.retryDelaysMs = [0, 0];
  // 本文件只验证联网/记忆工具注入；代码工具在 code-commands 测试中单独覆盖。
  config.codeBridge.enabled = false;
  // 测试必须指向临时目录，绝不允许读到本机真实 open-websearch endpoint。
  config.webSearch.endpointFile = join(runtimeDir, 'open-websearch.endpoint.json');
  return config;
}

function scriptedProvider(
  steps: ProviderStep[],
  options: { id?: 'deepseek' | 'dsh'; supportsTools?: boolean } = {},
): RecordingProvider {
  const requests: ChatRequest[] = [];
  let callIndex = 0;
  const provider: Provider = {
    id: options.id ?? 'deepseek',
    supportsTools: options.supportsTools ?? true,
    chat(req): ChatEventStream {
      requests.push({
        sessionId: req.sessionId,
        messages: req.messages.map((message) => ({ ...message })),
        ...(req.tools ? { tools: [...req.tools] } : {}),
      });
      const step = steps[Math.min(callIndex, steps.length - 1)] ?? {};
      callIndex += 1;
      return (async function* (): AsyncGenerator<ChatEvent> {
        if (step.toolCalls) {
          yield {
            type: 'tool_calls',
            toolCalls: step.toolCalls,
            reasoningContent: '',
          };
        } else if (step.text) {
          yield { type: 'text', text: step.text };
        }
        yield { type: 'done' };
      })();
    },
    usageOf: usageOfEvent,
    async health() {
      return { ok: true, detail: 'fake' };
    },
  };
  return { provider, requests };
}

async function startService(
  gateway: FakeGateway | null,
  options: {
    provider: Provider;
    configure?: (config: AppConfig) => void;
    store?: EventStore;
    receipts?: ReceiptStore;
    facts?: FactsStore;
    selfNotes?: SelfNoteStore;
    onWarn?: (message: string) => void;
  },
): Promise<QqService> {
  const config = baseConfig(
    gateway ? `http://127.0.0.1:${gateway.port}` : '',
  );
  options.configure?.(config);
  const service = await startQqService({
    config,
    persona: '测试人设',
    provider: options.provider,
    store: options.store,
    receipts: options.receipts,
    facts: options.facts,
    selfNotes: options.selfNotes,
    onWarn: options.onWarn ?? (() => undefined),
    onInfo: () => undefined,
  });
  services.push(service);
  return service;
}

function messagePayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  eventSeq += 1;
  return {
    v: 1,
    eventId: `evt:websearch:${eventSeq}`,
    at: Date.now(),
    source: { kind: 'private', id: String(OWNER_QQ), groupName: null },
    sender: { qqId: String(OWNER_QQ), nickname: '主人' },
    messageId: String(eventSeq),
    text: '在吗',
    isAtBot: false,
    quote: null,
    media: [],
    poke: null,
    ...overrides,
  };
}

function groupPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return messagePayload({
    source: { kind: 'group', id: String(GROUP_ID), groupName: '测试群' },
    sender: { qqId: '222333444', nickname: '群友' },
    ...overrides,
  });
}

async function postHook(service: QqService, payload: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${service.port}/hook/message`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-memory-token': TOKEN,
    },
    body: JSON.stringify(payload),
  });
}

function seedRecovered(): { store: EventStore; receipts: ReceiptStore } {
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
    eventId: 'evt:recovered-owner',
    sessionKey: `private:${OWNER_QQ}`,
    role: 'user',
    text: '恢复的 owner 私聊',
    speaker: null,
    quote: null,
    isAtBot: false,
    senderQqId: String(OWNER_QQ),
    modelEligible: true,
    at: NOW,
  });
  return { store, receipts };
}

function seedRecoveredGroup(): { store: EventStore; receipts: ReceiptStore } {
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
    eventId: 'evt:recovered-owner-group',
    sessionKey: `group:${GROUP_ID}`,
    role: 'user',
    text: '恢复的 owner 群聊',
    speaker: '主人',
    quote: null,
    isAtBot: true,
    senderQqId: String(OWNER_QQ),
    modelEligible: true,
    at: NOW,
  });
  return { store, receipts };
}

function toolsOf(request: ChatRequest | undefined): string[] {
  return (request?.tools ?? []).map((tool) => tool.name);
}

describe('QqService owner-only web tools', () => {
  it('live owner 私聊且 webSearch 启用时注入 tools', async () => {
    const gateway = await startGateway();
    const recording = scriptedProvider([{ text: '收到。' }]);
    const service = await startService(gateway, {
      provider: recording.provider,
      configure: (config) => {
        config.webSearch.enabled = true;
      },
    });

    const response = await postHook(
      service,
      messagePayload({ eventId: 'evt:live-owner', text: '查一下天气' }),
    );
    await service.waitForIdle();

    expect(response.status).toBe(200);
    expect(toolsOf(recording.requests[0])).toEqual([
      'web_search',
      'web_fetch',
      'memory_write',
      'library_write',
      'library_search',
      'library_read',
    ]);
    expect(gateway.requests).toEqual([
      { target: { kind: 'private', id: String(OWNER_QQ) }, messages: ['收到。'] },
    ]);
    expect(service.receipts.get('evt:live-owner')).toMatchObject({
      status: 'done',
      outcome: 'replied',
    });
  });

  it('伪造 sender.qqId 的 owner 私聊不注入 tools', async () => {
    const gateway = await startGateway();
    const recording = scriptedProvider([{ text: '收到。' }]);
    const service = await startService(gateway, {
      provider: recording.provider,
      configure: (config) => {
        config.webSearch.enabled = true;
      },
    });

    await postHook(
      service,
      messagePayload({
        eventId: 'evt:forged-owner',
        sender: { qqId: '987654321', nickname: '伪造者' },
      }),
    );
    await service.waitForIdle();

    expect(recording.requests).toHaveLength(1);
    expect(recording.requests[0]?.tools).toBeUndefined();
    expect(gateway.requests).toHaveLength(1);
  });

  it('recovered 事件不注入 tools', async () => {
    const gateway = await startGateway();
    const seeded = seedRecovered();
    const recording = scriptedProvider([{ text: '恢复后回复。' }]);
    const service = await startService(gateway, {
      provider: recording.provider,
      store: seeded.store,
      receipts: seeded.receipts,
      configure: (config) => {
        config.webSearch.enabled = true;
      },
    });

    await service.waitForIdle();

    expect(service.recoveredCount).toBe(1);
    expect(recording.requests).toHaveLength(1);
    expect(recording.requests[0]?.tools).toBeUndefined();
  });

  it('recovered 的 owner 群聊 @ 不注入 tools', async () => {
    const gateway = await startGateway();
    const seeded = seedRecoveredGroup();
    const recording = scriptedProvider([{ text: '恢复后回复。' }]);
    const service = await startService(gateway, {
      provider: recording.provider,
      store: seeded.store,
      receipts: seeded.receipts,
      configure: (config) => {
        config.webSearch.enabled = true;
      },
    });

    await service.waitForIdle();

    expect(service.recoveredCount).toBe(1);
    expect(recording.requests).toHaveLength(1);
    expect(recording.requests[0]?.tools).toBeUndefined();
    expect(service.receipts.get('evt:recovered-owner-group')).toMatchObject({
      status: 'done',
      outcome: 'replied',
    });
  });

  it('owner 群聊 @ 时注入联网工具，但不注入记忆工具', async () => {
    const gateway = await startGateway();
    const recording = scriptedProvider([{ text: '群内回复。' }]);
    const service = await startService(gateway, {
      provider: recording.provider,
      configure: (config) => {
        config.webSearch.enabled = true;
      },
    });

    await postHook(
      service,
      groupPayload({
        eventId: 'evt:owner-group',
        isAtBot: true,
        sender: { qqId: String(OWNER_QQ), nickname: '主人' },
      }),
    );
    await service.waitForIdle();

    expect(recording.requests).toHaveLength(1);
    expect(toolsOf(recording.requests[0])).toEqual(['web_search', 'web_fetch']);
    expect(gateway.requests).toEqual([
      { target: { kind: 'group', id: String(GROUP_ID) }, messages: ['群内回复。'] },
    ]);
    expect(service.receipts.get('evt:owner-group')).toMatchObject({
      status: 'done',
      outcome: 'replied',
    });
  });

  it('owner 群聊未 @ 时即使 groupWake=all 也不注入工具', async () => {
    const gateway = await startGateway();
    const recording = scriptedProvider([{ text: '群内回复。' }]);
    const service = await startService(gateway, {
      provider: recording.provider,
      configure: (config) => {
        config.webSearch.enabled = true;
        config.qq.groupWake = 'all';
      },
    });

    await postHook(
      service,
      groupPayload({
        eventId: 'evt:owner-group-no-mention',
        isAtBot: false,
        sender: { qqId: String(OWNER_QQ), nickname: '主人' },
      }),
    );
    await service.waitForIdle();

    expect(recording.requests).toHaveLength(1);
    expect(recording.requests[0]?.tools).toBeUndefined();
  });

  it('普通群成员 @ 不注入 tools', async () => {
    const gateway = await startGateway();
    const recording = scriptedProvider([{ text: '成员回复。' }]);
    const service = await startService(gateway, {
      provider: recording.provider,
      configure: (config) => {
        config.webSearch.enabled = true;
      },
    });

    await postHook(
      service,
      groupPayload({
        eventId: 'evt:member-group',
        isAtBot: true,
        sender: { qqId: '222333444', nickname: '张三' },
      }),
    );
    await service.waitForIdle();

    expect(recording.requests).toHaveLength(1);
    expect(recording.requests[0]?.tools).toBeUndefined();
  });

  it('同一批次 owner @ 与普通成员 @ 混包时不注入 tools', async () => {
    const gateway = await startGateway();
    const recording = scriptedProvider([{ text: '混包回复。' }]);
    const service = await startService(gateway, {
      provider: recording.provider,
      configure: (config) => {
        config.webSearch.enabled = true;
        config.qq.batchWindowMs = 1_500;
      },
    });

    await postHook(
      service,
      groupPayload({
        eventId: 'evt:group-mixed-owner',
        isAtBot: true,
        text: 'owner 的提问',
        sender: { qqId: String(OWNER_QQ), nickname: '主人' },
      }),
    );
    await postHook(
      service,
      groupPayload({
        eventId: 'evt:group-mixed-member',
        isAtBot: true,
        text: '成员的提问',
        sender: { qqId: '222333444', nickname: '张三' },
      }),
    );
    await service.waitForIdle();

    expect(recording.requests).toHaveLength(1);
    expect(recording.requests[0]?.tools).toBeUndefined();
    const modelText = recording.requests[0]?.messages.at(-1)?.content ?? '';
    expect(modelText).toContain('owner 的提问');
    expect(modelText).toContain('成员的提问');
  });

  it('groupWake=all 时 owner @ 与成员普通消息同包也不注入 tools', async () => {
    const gateway = await startGateway();
    const recording = scriptedProvider([{ text: '混包回复。' }]);
    const service = await startService(gateway, {
      provider: recording.provider,
      configure: (config) => {
        config.webSearch.enabled = true;
        config.qq.groupWake = 'all';
        config.qq.batchWindowMs = 1_500;
      },
    });

    await postHook(
      service,
      groupPayload({
        eventId: 'evt:all-mixed-owner',
        isAtBot: true,
        text: 'owner 的联网问题',
        sender: { qqId: String(OWNER_QQ), nickname: '主人' },
      }),
    );
    await postHook(
      service,
      groupPayload({
        eventId: 'evt:all-mixed-member',
        isAtBot: false,
        text: '成员的普通消息',
        sender: { qqId: '222333444', nickname: '张三' },
      }),
    );
    await service.waitForIdle();

    expect(recording.requests).toHaveLength(1);
    expect(recording.requests[0]?.tools).toBeUndefined();
    const modelText = recording.requests[0]?.messages.at(-1)?.content ?? '';
    expect(modelText).toContain('owner 的联网问题');
    expect(modelText).toContain('成员的普通消息');
  });

  it('owner @ 时成员未唤醒消息只存且不进入模型包', async () => {
    const gateway = await startGateway();
    const recording = scriptedProvider([{ text: '只回 owner。' }]);
    const service = await startService(gateway, {
      provider: recording.provider,
      configure: (config) => {
        config.webSearch.enabled = true;
        config.qq.batchWindowMs = 1_500;
      },
    });

    await postHook(
      service,
      groupPayload({
        eventId: 'evt:group-stored-owner',
        isAtBot: true,
        text: 'owner 的联网问题',
        sender: { qqId: String(OWNER_QQ), nickname: '主人' },
      }),
    );
    await postHook(
      service,
      groupPayload({
        eventId: 'evt:group-stored-member',
        isAtBot: false,
        text: '成员只存不唤醒的闲聊',
        sender: { qqId: '222333444', nickname: '张三' },
      }),
    );
    await service.waitForIdle();

    expect(recording.requests).toHaveLength(1);
    expect(toolsOf(recording.requests[0])).toEqual(['web_search', 'web_fetch']);
    const modelText = recording.requests[0]?.messages.at(-1)?.content ?? '';
    expect(modelText).toContain('owner 的联网问题');
    expect(modelText).not.toContain('成员只存不唤醒的闲聊');
    expect(service.receipts.get('evt:group-stored-member')).toMatchObject({
      status: 'done',
      outcome: 'stored_only',
    });
  });

  it('伪造 owner 身份的群消息不注入 tools', async () => {
    const gateway = await startGateway();
    const recording = scriptedProvider([{ text: '群内回复。' }]);
    const service = await startService(gateway, {
      provider: recording.provider,
      configure: (config) => {
        config.webSearch.enabled = true;
      },
    });

    await postHook(
      service,
      groupPayload({
        eventId: 'evt:forged-owner-group',
        isAtBot: true,
        sender: { qqId: '987654321', nickname: '伪造者' },
      }),
    );
    await service.waitForIdle();

    expect(recording.requests).toHaveLength(1);
    expect(recording.requests[0]?.tools).toBeUndefined();
  });

  it('陌生私聊不进入模型，自然无 tools', async () => {
    const gateway = await startGateway();
    const recording = scriptedProvider([{ text: '不应回复。' }]);
    const service = await startService(gateway, {
      provider: recording.provider,
      configure: (config) => {
        config.webSearch.enabled = true;
      },
    });

    const response = await postHook(
      service,
      messagePayload({
        eventId: 'evt:stranger-private',
        source: { kind: 'private', id: '30003', groupName: null },
        sender: { qqId: '30003', nickname: '陌生人' },
      }),
    );
    await service.waitForIdle();

    expect(response.status).toBe(200);
    expect(recording.requests).toHaveLength(0);
    expect(gateway.requests).toHaveLength(0);
  });

  it('混批含非 live owner 条目时不注入 tools', async () => {
    const gateway = await startGateway();
    const recording = scriptedProvider([{ text: '混批回复。' }]);
    const service = await startService(gateway, {
      provider: recording.provider,
      configure: (config) => {
        config.webSearch.enabled = true;
        config.qq.batchWindowMs = 1_500;
      },
    });

    await postHook(
      service,
      messagePayload({ eventId: 'evt:mixed-live-owner', text: '第一条实时消息' }),
    );
    await postHook(
      service,
      messagePayload({
        eventId: 'evt:mixed-forged',
        text: '伪造 sender 的第二条',
        sender: { qqId: '987654321', nickname: '伪造者' },
      }),
    );
    await service.waitForIdle();

    expect(recording.requests).toHaveLength(1);
    expect(recording.requests[0]?.tools).toBeUndefined();
    const modelText = recording.requests[0]?.messages.at(-1)?.content ?? '';
    expect(modelText).toContain('第一条实时消息');
    expect(modelText).toContain('伪造 sender 的第二条');
  });

  it('webSearch.enabled=false 时不注入联网工具，但保留记忆工具', async () => {
    const gateway = await startGateway();
    const recording = scriptedProvider([{ text: '收到。' }]);
    const service = await startService(gateway, {
      provider: recording.provider,
      configure: (config) => {
        config.webSearch.enabled = false;
      },
    });

    await postHook(service, messagePayload({ eventId: 'evt:disabled' }));
    await service.waitForIdle();

    expect(recording.requests).toHaveLength(1);
    expect(toolsOf(recording.requests[0])).toEqual([
      'memory_write',
      'library_write',
      'library_search',
      'library_read',
    ]);
  });

  it('webSearch 关闭时 owner 私聊仍可通过 memory_write 写入事实', async () => {
    const gateway = await startGateway();
    const facts = new FactsStore({
      dir: memoryFactsDir(stateDir),
      halfLifeDays: 45,
      archiveThreshold: 1,
      injectMax: 10,
      injectMaxChars: 1000,
      autoReviewEnabled: false,
      onWarn: () => undefined,
    });
    const recording = scriptedProvider([
      {
        toolCalls: [
          {
            id: 'call-memory',
            name: 'memory_write',
            argumentsText: JSON.stringify({
              category: 'fact',
              text: '主人喜欢美式咖啡',
              tag: 'preference',
            }),
          },
        ],
      },
      { text: '记住了。' },
    ]);
    const service = await startService(gateway, {
      provider: recording.provider,
      facts,
      configure: (config) => {
        config.webSearch.enabled = false;
      },
    });

    await postHook(
      service,
      messagePayload({ eventId: 'evt:memory-write', text: '记住我喜欢美式咖啡' }),
    );
    await service.waitForIdle();

    expect(toolsOf(recording.requests[0])).toEqual([
      'memory_write',
      'library_write',
      'library_search',
      'library_read',
    ]);
    const toolMessage = recording.requests[1]?.messages.at(-1);
    expect(toolMessage?.role).toBe('tool');
    expect(toolMessage?.content).toContain('已记住');
    expect(facts.listLive(`private:${OWNER_QQ}`)).toEqual([
      expect.objectContaining({
        text: '主人喜欢美式咖啡',
        tag: 'preference',
      }),
    ]);
    expect(gateway.requests).toEqual([
      {
        target: { kind: 'private', id: String(OWNER_QQ) },
        messages: ['记住了。'],
      },
    ]);
    expect(service.receipts.get('evt:memory-write')).toMatchObject({
      status: 'done',
      outcome: 'replied',
    });
  });

  it('memory_write 写入的 selfNote 在下一轮立即进入 system prompt', async () => {
    const gateway = await startGateway();
    const selfNotes = new SelfNoteStore({
      dir: memorySelfNotesDir(stateDir),
      max: 40,
      bootstrapLimit: 20,
      onWarn: () => undefined,
    });
    const recording = scriptedProvider([
      {
        toolCalls: [
          {
            id: 'call-self-note',
            name: 'memory_write',
            argumentsText: JSON.stringify({
              category: 'selfNote',
              text: '这是测试自认知',
            }),
          },
        ],
      },
      { text: '记住了。' },
      { text: '第二轮。' },
    ]);
    const service = await startService(gateway, {
      provider: recording.provider,
      selfNotes,
      configure: (config) => {
        config.webSearch.enabled = false;
      },
    });

    await postHook(
      service,
      messagePayload({ eventId: 'evt:self-note-1', text: '记住你的自认知' }),
    );
    await service.waitForIdle();
    await postHook(
      service,
      messagePayload({ eventId: 'evt:self-note-2', text: '第二轮' }),
    );
    await service.waitForIdle();

    expect(recording.requests).toHaveLength(3);
    const systemPrompt = recording.requests[2]?.messages[0];
    expect(systemPrompt?.role).toBe('system');
    expect(systemPrompt?.content).toContain('这是测试自认知');
    expect(selfNotes.list(`private:${OWNER_QQ}`)).toHaveLength(1);
  });

  it('DSH provider（supportsTools=false）不注入 tools', async () => {
    const gateway = await startGateway();
    const recording = scriptedProvider([{ text: 'DSH 回复。' }], {
      id: 'dsh',
      supportsTools: false,
    });
    const service = await startService(gateway, {
      provider: recording.provider,
      configure: (config) => {
        config.webSearch.enabled = true;
      },
    });

    await postHook(service, messagePayload({ eventId: 'evt:dsh' }));
    await service.waitForIdle();

    expect(recording.requests).toHaveLength(1);
    expect(recording.requests[0]?.tools).toBeUndefined();
    expect(gateway.requests).toHaveLength(1);
  });

  it('daemon 不可用时模型仍正常回复', async () => {
    const gateway = await startGateway();
    const warnings: string[] = [];
    const recording = scriptedProvider([
      {
        toolCalls: [
          {
            id: 'call-1',
            name: 'web_search',
            argumentsText: JSON.stringify({ query: '测试' }),
          },
        ],
      },
      { text: '联网不可用，直接回答。' },
    ]);
    const service = await startService(gateway, {
      provider: recording.provider,
      onWarn: (message) => warnings.push(message),
      configure: (config) => {
        config.webSearch.enabled = true;
        config.webSearch.endpointFile = join(runtimeDir, 'missing-endpoint.json');
      },
    });

    await postHook(service, messagePayload({ eventId: 'evt:daemon-down' }));
    await service.waitForIdle();

    expect(recording.requests).toHaveLength(2);
    expect(toolsOf(recording.requests[0])).toEqual([
      'web_search',
      'web_fetch',
      'memory_write',
      'library_write',
      'library_search',
      'library_read',
    ]);
    const toolMessage = recording.requests[1]?.messages.at(-1);
    expect(toolMessage?.role).toBe('tool');
    expect(toolMessage?.content).toContain('web_endpoint_unavailable');
    expect(gateway.requests).toEqual([
      {
        target: { kind: 'private', id: String(OWNER_QQ) },
        messages: ['联网不可用，直接回答。'],
      },
    ]);
    expect(service.receipts.get('evt:daemon-down')).toMatchObject({
      status: 'done',
      outcome: 'replied',
    });
    expect(warnings.join('\n')).not.toContain(runtimeDir);
    expect(warnings.join('\n')).not.toContain('missing-endpoint.json');
  });
});

function fakeWebRuntime(
  sessionKey: string,
  state: { beginTurn: number },
): AgentWebToolRuntime {
  return {
    ownerSessionKey: sessionKey,
    specs: [
      {
        name: 'web_search',
        description: '测试工具',
        parameters: { type: 'object' },
      },
    ],
    maxResultChars: 12_000,
    maxRoundChars: 24_000,
    beginTurn() {
      state.beginTurn += 1;
    },
    async execute(call) {
      return {
        toolCallId: call.id,
        name: call.name,
        ok: true,
        content: '测试结果',
        truncated: false,
      };
    },
  };
}

function fakeReceipts(): Pick<
  QqReceiptStore,
  'markProcessing' | 'markDone' | 'markFailed'
> {
  return {
    markProcessing() {
      return true;
    },
    markDone() {
      return true;
    },
    markFailed() {
      return true;
    },
  };
}

function allSentSender(): QqSender {
  return {
    async send(_target, messages): Promise<SendResult> {
      return {
        outcome: 'all_sent',
        sentIndexes: messages.map((_message, index) => index),
        failedIndexes: [],
        retryable: false,
        retryAfterMs: null,
        reason: null,
      };
    },
  };
}

function oneItemWake(eventId: string): WakePacket {
  return {
    sessionKey: `private:${OWNER_QQ}`,
    items: [
      {
        eventId,
        speaker: null,
        senderRole: 'owner',
        quote: null,
        text: '查一下',
        at: NOW,
      },
    ],
    omittedEventIds: [],
    modelText: '查一下',
    totalChars: 3,
    truncatedCount: 0,
  };
}

describe('runQqTurn web tool gating', () => {
  it('webToolsAllowed=false 时即使传入 runtime 也不交给 Agent', async () => {
    const state = { beginTurn: 0 };
    const recording = scriptedProvider([{ text: '好。' }]);
    const store = new EventStore({
      dir: join(rootDir, 'turn-denied'),
      now: () => NOW,
    });
    store.append({
      id: 'evt:turn-denied',
      src: 'qq',
      sessionKey: `private:${OWNER_QQ}`,
      role: 'user',
      text: '查一下',
      t: NOW,
    });
    const registry = new AgentRegistry({
      createAgent: (sessionKey) =>
        new Agent({
          provider: recording.provider,
          store,
          persona: '测试人设',
          sessionKey,
          src: 'qq',
          now: () => NOW,
        }),
    });

    await runQqTurn({
      registry,
      sessionKey: `private:${OWNER_QQ}`,
      wake: oneItemWake('evt:turn-denied'),
      sender: allSentSender(),
      receipts: fakeReceipts(),
      target: { kind: 'private', id: String(OWNER_QQ) },
      maxPerTurn: 3,
      signal: new AbortController().signal,
      webToolsAllowed: false,
      webTools: fakeWebRuntime(`private:${OWNER_QQ}`, state),
    });

    expect(recording.requests[0]?.tools).toBeUndefined();
    expect(state.beginTurn).toBe(0);
  });

  it('webToolsAllowed=true 时才把 runtime 交给 Agent', async () => {
    const state = { beginTurn: 0 };
    const recording = scriptedProvider([{ text: '好。' }]);
    const store = new EventStore({
      dir: join(rootDir, 'turn-allowed'),
      now: () => NOW,
    });
    store.append({
      id: 'evt:turn-allowed',
      src: 'qq',
      sessionKey: `private:${OWNER_QQ}`,
      role: 'user',
      text: '查一下',
      t: NOW,
    });
    const registry = new AgentRegistry({
      createAgent: (sessionKey) =>
        new Agent({
          provider: recording.provider,
          store,
          persona: '测试人设',
          sessionKey,
          src: 'qq',
          now: () => NOW,
        }),
    });

    await runQqTurn({
      registry,
      sessionKey: `private:${OWNER_QQ}`,
      wake: oneItemWake('evt:turn-allowed'),
      sender: allSentSender(),
      receipts: fakeReceipts(),
      target: { kind: 'private', id: String(OWNER_QQ) },
      maxPerTurn: 3,
      signal: new AbortController().signal,
      webToolsAllowed: true,
      webTools: fakeWebRuntime(`private:${OWNER_QQ}`, state),
    });

    expect(toolsOf(recording.requests[0])).toEqual(['web_search']);
    expect(state.beginTurn).toBe(1);
  });
});

describe('CLI default', () => {
  it('CLI runTurn 不传 tools', async () => {
    const recording = scriptedProvider([{ text: 'CLI 回复。' }]);
    const store = new EventStore({
      dir: join(rootDir, 'cli-events'),
      now: () => NOW,
    });
    const agent = new Agent({
      provider: recording.provider,
      store,
      persona: '测试人设',
      sessionKey: 'cli:default',
      src: 'cli',
      now: () => NOW,
    });

    await agent.runTurn('你好', {
      signal: new AbortController().signal,
      writeUserL0: false,
      writeAssistantL0: false,
    });

    expect(recording.requests).toHaveLength(1);
    expect(recording.requests[0]?.tools).toBeUndefined();
  });
});
