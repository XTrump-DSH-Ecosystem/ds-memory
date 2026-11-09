import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Agent } from '../../src/agent/loop.ts';
import {
  defaultRuntimeDir,
  loadConfig,
  type AppConfig,
} from '../../src/config/load.ts';
import { EventStore } from '../../src/memory/store.ts';
import {
  usageOfEvent,
  type ChatEvent,
  type ChatEventStream,
  type ChatRequest,
  type Provider,
  type ToolCall,
} from '../../src/provider/types.ts';
import { SessionInbox } from '../../src/qq/inbox.ts';
import { ReceiptStore } from '../../src/qq/receipts.ts';
import {
  startQqService,
  type GatewayClient,
  type QqService,
} from '../../src/qq/service.ts';
import type {
  InboxItem,
  QqTarget,
  RecoveredReceipt,
  SendResult,
} from '../../src/qq/types.ts';
import { memoryEventsDir } from '../../src/state/paths.ts';

const OWNER_QQ = 123456789;
const GROUP_ID = 555000111;
const TOKEN = '0123456789abcdef0123456789abcdef0123456789abcdef';
const NOW = 1_700_000_000_000;

interface ProviderStep {
  text?: string;
  toolCalls?: ToolCall[];
}

interface ProviderOptions {
  id?: 'deepseek' | 'dsh';
  supportsTools?: boolean;
}

class RecordingProvider implements Provider {
  readonly id: 'deepseek' | 'dsh';
  readonly supportsTools: boolean | undefined;
  readonly requests: ChatRequest[] = [];
  private readonly steps: readonly ProviderStep[];
  private index = 0;

  constructor(steps: readonly ProviderStep[], options: ProviderOptions = {}) {
    this.steps = steps;
    this.id = options.id ?? 'deepseek';
    this.supportsTools = options.supportsTools;
  }

  chat(req: ChatRequest, _opts: { signal: AbortSignal }): ChatEventStream {
    this.requests.push({
      sessionId: req.sessionId,
      messages: req.messages.map((message) => ({ ...message })),
      ...(req.tools ? { tools: [...req.tools] } : {}),
    });

    const step = this.steps[Math.min(this.index, this.steps.length - 1)];
    this.index += 1;
    if (!step) throw new Error('验收 Provider 缺少脚本步骤');

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
  }

  usageOf(event: ChatEvent) {
    return usageOfEvent(event);
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    return { ok: true, detail: 'recording-provider' };
  }
}

class SuppressRecoveredReceipts extends ReceiptStore {
  /**
   * Synthetic-batch tests need the injected raw inbox item to be the only
   * batch entry. Recovery itself is covered separately by the real bootstrap.
   */
  override bootstrapFromL0(): { recovered: RecoveredReceipt[]; aborted: string[] } {
    super.bootstrapFromL0();
    return { recovered: [], aborted: [] };
  }
}

interface SentBatch {
  target: QqTarget;
  messages: string[];
}

interface ServiceHarness {
  service: QqService;
  provider: RecordingProvider;
  sent: SentBatch[];
  warnings: string[];
  infos: string[];
}

interface StartServiceOptions {
  provider: RecordingProvider;
  configure?: (config: AppConfig) => void;
  store?: EventStore;
  receipts?: ReceiptStore;
  inbox?: SessionInbox;
}

let rootDir: string;
let stateDir: string;
let runtimeDir: string;
let services: QqService[];
let eventSeq: number;

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'xds-t1-w4-'));
  stateDir = join(rootDir, 'state');
  runtimeDir = join(rootDir, 'runtime');
  services = [];
  eventSeq = 0;
});

afterEach(async () => {
  while (services.length > 0) {
    await services.pop()!.stop();
  }
  rmSync(rootDir, { recursive: true, force: true });
});

function baseConfig(): AppConfig {
  const config = structuredClone(
    loadConfig(join(rootDir, 'no-config-here')).config,
  );
  config.stateDir = stateDir;
  config.qq.enabled = true;
  config.qq.hookPort = 0;
  config.qq.hookToken = TOKEN;
  config.qq.ownerQQ = OWNER_QQ;
  config.qq.allowGroups = [GROUP_ID];
  config.qq.gatewayUrl = '';
  config.qq.runtimeDir = runtimeDir;
  config.qq.batchWindowMs = 20;
  config.qq.healthIntervalMs = 60_000;
  config.qq.send.retryDelaysMs = [0, 0];
  // Never allow an acceptance test to read the real machine's endpoint file.
  config.webSearch.endpointFile = join(runtimeDir, 'open-websearch.endpoint.json');
  return config;
}

function recordingGateway(): { gateway: GatewayClient; sent: SentBatch[] } {
  const sent: SentBatch[] = [];
  const gateway: GatewayClient = {
    async send(target, messages): Promise<SendResult> {
      sent.push({
        target: { kind: target.kind, id: target.id },
        messages: [...messages],
      });
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
  return { gateway, sent };
}

async function startService(options: StartServiceOptions): Promise<ServiceHarness> {
  const config = baseConfig();
  options.configure?.(config);
  const { gateway, sent } = recordingGateway();
  const warnings: string[] = [];
  const infos: string[] = [];
  const service = await startQqService({
    config,
    persona: 'T1 W4 验收人设',
    provider: options.provider,
    store: options.store,
    receipts: options.receipts,
    inbox: options.inbox,
    senderFactory: () => gateway,
    discovery: {
      resolve: () => ({
        kind: 'explicit' as const,
        baseUrl: 'http://127.0.0.1:9',
      }),
    },
    onWarn: (message) => warnings.push(message),
    onInfo: (message) => infos.push(message),
  });
  services.push(service);
  return { service, provider: options.provider, sent, warnings, infos };
}

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  eventSeq += 1;
  return {
    v: 1,
    eventId: `evt:t1-w4:${eventSeq}`,
    at: Date.now(),
    source: { kind: 'private', id: String(OWNER_QQ), groupName: null },
    sender: { qqId: String(OWNER_QQ), nickname: '主人' },
    messageId: String(eventSeq),
    text: '你好',
    isAtBot: false,
    quote: null,
    media: [],
    poke: null,
    ...overrides,
  };
}

function groupPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return payload({
    source: { kind: 'group', id: String(GROUP_ID), groupName: '验收群' },
    sender: { qqId: '222333444', nickname: '群友' },
    isAtBot: true,
    ...overrides,
  });
}

async function postHook(
  service: QqService,
  body: Record<string, unknown>,
): Promise<Response> {
  return fetch(`http://127.0.0.1:${service.port}/hook/message`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-memory-token': TOKEN,
    },
    body: JSON.stringify(body),
  });
}

function toolsOf(request: ChatRequest | undefined): string[] {
  return (request?.tools ?? []).map((tool) => tool.name);
}

function lastContent(request: ChatRequest | undefined): string {
  const last = request?.messages.at(-1);
  return last ? last.content : '';
}

function makeEventStore(): EventStore {
  return new EventStore({
    dir: memoryEventsDir(stateDir),
    now: () => NOW,
    onWarn: () => undefined,
  });
}

function makeReceipts(
  store: EventStore,
  suppressRecovery = false,
): ReceiptStore {
  const options = {
    dir: join(stateDir, 'qq'),
    store,
    now: () => NOW,
    onWarn: () => undefined,
  };
  return suppressRecovery
    ? new SuppressRecoveredReceipts(options)
    : new ReceiptStore(options);
}

function reserveOwnerReceipt(
  receipts: ReceiptStore,
  eventId: string,
  text: string,
): void {
  const result = receipts.reserve({
    eventId,
    sessionKey: `private:${OWNER_QQ}`,
    role: 'user',
    text,
    speaker: null,
    quote: null,
    isAtBot: false,
    senderQqId: String(OWNER_QQ),
    modelEligible: true,
    at: NOW,
  });
  if (result.kind !== 'new') throw new Error(`预置 Receipt 失败：${result.kind}`);
}

describe('T1 W4 独立验收：owner-only QQ 联网权限', () => {
  it('live owner 私聊在 webSearch 启用且 Provider 支持 tools 时注入联网与记忆工具', async () => {
    const provider = new RecordingProvider([{ text: '收到。' }], {
      supportsTools: true,
    });
    const harness = await startService({
      provider,
      configure: (config) => {
        config.webSearch.enabled = true;
      },
    });

    const response = await postHook(
      harness.service,
      payload({
        eventId: 'evt:t1-live-owner',
        text: '查一下天气',
      }),
    );
    await harness.service.waitForIdle();

    expect(response.status).toBe(200);
    expect(provider.requests).toHaveLength(1);
    expect(toolsOf(provider.requests[0])).toEqual([
      'web_search',
      'web_fetch',
      'memory_write',
      'library_write',
      'library_search',
      'library_read',
    ]);
    expect(harness.sent).toEqual([
      {
        target: { kind: 'private', id: String(OWNER_QQ) },
        messages: ['收到。'],
      },
    ]);
    expect(harness.service.receipts.get('evt:t1-live-owner')).toMatchObject({
      status: 'done',
      outcome: 'replied',
    });
  });

  it('同一 session 的下一批伪造 sender 不继承上一批 tools', async () => {
    const provider = new RecordingProvider(
      [{ text: '第一轮。' }, { text: '第二轮。' }],
      { supportsTools: true },
    );
    const harness = await startService({
      provider,
      configure: (config) => {
        config.webSearch.enabled = true;
      },
    });

    await postHook(
      harness.service,
      payload({ eventId: 'evt:t1-reuse-owner', text: '第一条' }),
    );
    await harness.service.waitForIdle();
    await postHook(
      harness.service,
      payload({
        eventId: 'evt:t1-reuse-forged',
        text: '第二条',
        sender: { qqId: '987654321', nickname: '伪造者' },
      }),
    );
    await harness.service.waitForIdle();

    expect(provider.requests).toHaveLength(2);
    expect(toolsOf(provider.requests[0])).toEqual([
      'web_search',
      'web_fetch',
      'memory_write',
      'library_write',
      'library_search',
      'library_read',
    ]);
    expect(provider.requests[1]?.tools).toBeUndefined();
    expect(harness.sent).toHaveLength(2);
    expect(harness.service.receipts.get('evt:t1-reuse-forged')).toMatchObject({
      status: 'done',
      outcome: 'replied',
    });
  });

  it('recovered 的 owner 私聊不注入 tools', async () => {
    const store = makeEventStore();
    const receipts = makeReceipts(store);
    reserveOwnerReceipt(receipts, 'evt:t1-recovered-owner', '恢复的 owner 私聊');
    const provider = new RecordingProvider([{ text: '恢复后回复。' }], {
      supportsTools: true,
    });

    const harness = await startService({
      provider,
      store,
      receipts,
      configure: (config) => {
        config.webSearch.enabled = true;
      },
    });
    await harness.service.waitForIdle();

    expect(harness.service.recoveredCount).toBe(1);
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.tools).toBeUndefined();
    expect(harness.sent).toHaveLength(1);
    expect(harness.service.receipts.get('evt:t1-recovered-owner')).toMatchObject({
      status: 'done',
      outcome: 'replied',
    });
  });

  it('owner 在群聊 @ 时注入联网工具，但不注入记忆工具', async () => {
    const provider = new RecordingProvider([{ text: '群内回复。' }], {
      supportsTools: true,
    });
    const harness = await startService({
      provider,
      configure: (config) => {
        config.webSearch.enabled = true;
      },
    });

    await postHook(
      harness.service,
      groupPayload({
        eventId: 'evt:t1-owner-group',
        sender: { qqId: String(OWNER_QQ), nickname: '主人' },
      }),
    );
    await harness.service.waitForIdle();

    expect(provider.requests).toHaveLength(1);
    expect(toolsOf(provider.requests[0])).toEqual(['web_search', 'web_fetch']);
    expect(harness.sent).toHaveLength(1);
  });

  it('普通群成员 @ 机器人不注入 tools', async () => {
    const provider = new RecordingProvider([{ text: '成员回复。' }], {
      supportsTools: true,
    });
    const harness = await startService({
      provider,
      configure: (config) => {
        config.webSearch.enabled = true;
      },
    });

    await postHook(
      harness.service,
      groupPayload({
        eventId: 'evt:t1-member-group',
        sender: { qqId: '222333444', nickname: '群友' },
      }),
    );
    await harness.service.waitForIdle();

    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.tools).toBeUndefined();
    expect(harness.sent).toHaveLength(1);
  });

  it('陌生私聊不进入模型', async () => {
    const provider = new RecordingProvider([{ text: '不应回复。' }], {
      supportsTools: true,
    });
    const harness = await startService({
      provider,
      configure: (config) => {
        config.webSearch.enabled = true;
      },
    });

    const response = await postHook(
      harness.service,
      payload({
        eventId: 'evt:t1-stranger',
        source: { kind: 'private', id: '30003', groupName: null },
        sender: { qqId: '30003', nickname: '陌生人' },
      }),
    );
    await harness.service.waitForIdle();

    expect(response.status).toBe(200);
    expect(provider.requests).toHaveLength(0);
    expect(harness.sent).toHaveLength(0);
    expect(harness.service.receipts.count).toBe(0);
  });

  it('第 13 条被 wake 省略时，本包按实际 included owner 条目授权；下一批 recovered fail-closed', async () => {
    const store = makeEventStore();
    const receipts = makeReceipts(store, true);
    const inbox = new SessionInbox();
    const sessionKey = `private:${OWNER_QQ}`;

    for (let index = 0; index < 13; index += 1) {
      const eventId = `evt:t1-raw-batch-${index}`;
      const text = index === 12 ? '第十三条伪造条目' : `第${index + 1}条 live owner`;
      reserveOwnerReceipt(receipts, eventId, text);
      const item: InboxItem = {
        eventId,
        sessionKey,
        kind: 'private',
        speaker: null,
        senderRole: 'owner',
        origin: index === 12 ? 'recovered' : 'live',
        senderQqId: String(OWNER_QQ),
        text,
        quote: null,
        isAtBot: false,
        receivedAt: NOW,
      };
      inbox.enqueue(item);
    }

    const provider = new RecordingProvider(
      [{ text: '第一批回复。' }, { text: '第二批回复。' }],
      { supportsTools: true },
    );
    const harness = await startService({
      provider,
      store,
      receipts,
      inbox,
      configure: (config) => {
        config.webSearch.enabled = true;
        config.qq.batchWindowMs = 10;
        config.qq.batchMaxMessages = 12;
      },
    });
    await harness.service.waitForIdle();

    expect(provider.requests).toHaveLength(2);
    expect(toolsOf(provider.requests[0])).toEqual(['web_search', 'web_fetch']);
    expect(provider.requests[1]?.tools).toBeUndefined();
    expect(lastContent(provider.requests[0])).toContain('第12条 live owner');
    expect(lastContent(provider.requests[0])).not.toContain('第十三条伪造条目');
    expect(lastContent(provider.requests[1])).toContain('第十三条伪造条目');
  });

  it('webSearch.enabled=false 时不注入联网工具，但保留记忆工具', async () => {
    const provider = new RecordingProvider([{ text: '收到。' }], {
      supportsTools: true,
    });
    const harness = await startService({
      provider,
      configure: (config) => {
        config.webSearch.enabled = false;
      },
    });

    await postHook(
      harness.service,
      payload({ eventId: 'evt:t1-disabled' }),
    );
    await harness.service.waitForIdle();

    expect(provider.requests).toHaveLength(1);
    expect(toolsOf(provider.requests[0])).toEqual([
      'memory_write',
      'library_write',
      'library_search',
      'library_read',
    ]);
    expect(harness.sent).toHaveLength(1);
  });

  it('Provider.supportsTools=false 时不注入 tools', async () => {
    const provider = new RecordingProvider([{ text: '不支持工具。' }], {
      id: 'deepseek',
      supportsTools: false,
    });
    const harness = await startService({
      provider,
      configure: (config) => {
        config.webSearch.enabled = true;
      },
    });

    await postHook(
      harness.service,
      payload({ eventId: 'evt:t1-no-provider-tools' }),
    );
    await harness.service.waitForIdle();

    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.tools).toBeUndefined();
    expect(harness.sent).toHaveLength(1);
  });

  it('endpoint 缺失时工具调用返回固定错误，模型仍完成文本回复且日志不泄露路径', async () => {
    const provider = new RecordingProvider(
      [
        {
          toolCalls: [
            {
              id: 'call:t1-endpoint-missing',
              name: 'web_search',
              argumentsText: JSON.stringify({ query: 'T1_SECRET_QUERY' }),
            },
          ],
        },
        { text: '联网不可用，直接回答。' },
      ],
      { supportsTools: true },
    );
    const missingEndpoint = join(runtimeDir, 'definitely-missing.endpoint.json');
    const harness = await startService({
      provider,
      configure: (config) => {
        config.webSearch.enabled = true;
        config.webSearch.endpointFile = missingEndpoint;
      },
    });

    await postHook(
      harness.service,
      payload({ eventId: 'evt:t1-endpoint-missing', text: '查一下' }),
    );
    await harness.service.waitForIdle();

    expect(provider.requests).toHaveLength(2);
    expect(toolsOf(provider.requests[0])).toEqual([
      'web_search',
      'web_fetch',
      'memory_write',
      'library_write',
      'library_search',
      'library_read',
    ]);
    const toolMessage = provider.requests[1]?.messages.find(
      (message) => message.role === 'tool',
    );
    expect(toolMessage?.content).toContain('web_endpoint_unavailable');
    expect(harness.sent).toEqual([
      {
        target: { kind: 'private', id: String(OWNER_QQ) },
        messages: ['联网不可用，直接回答。'],
      },
    ]);
    expect(harness.service.receipts.get('evt:t1-endpoint-missing')).toMatchObject({
      status: 'done',
      outcome: 'replied',
    });

    const logs = [...harness.warnings, ...harness.infos].join('\n');
    expect(logs).not.toContain(runtimeDir);
    expect(logs).not.toContain('definitely-missing.endpoint.json');
    expect(logs).not.toContain('T1_SECRET_QUERY');
  });

  it('CLI 回合不注入 tools', async () => {
    const provider = new RecordingProvider([{ text: 'CLI 回复。' }], {
      supportsTools: true,
    });
    const store = makeEventStore();
    const agent = new Agent({
      provider,
      store,
      persona: 'CLI 验收人设',
      sessionKey: 'cli:t1-w4',
      src: 'cli',
      now: () => NOW,
    });

    await agent.runTurn('CLI 消息', {
      signal: new AbortController().signal,
      writeUserL0: false,
      writeAssistantL0: false,
    });

    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.tools).toBeUndefined();
  });

  it('code 控制命令不进入模型，也不注入 tools', async () => {
    const provider = new RecordingProvider([{ text: '不应回复。' }], {
      supportsTools: true,
    });
    const harness = await startService({
      provider,
      configure: (config) => {
        config.webSearch.enabled = true;
      },
    });

    const response = await postHook(
      harness.service,
      payload({ eventId: 'evt:t1-code-command', text: 'code 检查一下仓库' }),
    );
    await harness.service.waitForIdle();

    expect(response.status).toBe(200);
    expect(provider.requests).toHaveLength(0);
    expect(harness.sent).toHaveLength(0);
    expect(harness.service.receipts.count).toBe(0);
  });
});

describe('T1 W4 独立验收：缺失字段 fail-closed', () => {
  it('live owner 私聊条目缺失 origin 时不注入 tools', async () => {
    const store = makeEventStore();
    const receipts = makeReceipts(store, true);
    const inbox = new SessionInbox();
    const eventId = 'evt:t1-missing-origin';
    reserveOwnerReceipt(receipts, eventId, '缺少 origin 的条目');
    const item: InboxItem = {
      eventId,
      sessionKey: `private:${OWNER_QQ}`,
      kind: 'private',
      speaker: null,
      senderRole: 'owner',
      senderQqId: String(OWNER_QQ),
      text: '缺少 origin 的条目',
      quote: null,
      isAtBot: false,
      receivedAt: NOW,
    };
    inbox.enqueue(item);

    const provider = new RecordingProvider([{ text: '收到。' }], {
      supportsTools: true,
    });
    const harness = await startService({
      provider,
      store,
      receipts,
      inbox,
      configure: (config) => {
        config.webSearch.enabled = true;
        config.qq.batchWindowMs = 10;
      },
    });
    await harness.service.waitForIdle();

    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.tools).toBeUndefined();
    expect(harness.service.receipts.get(eventId)).toMatchObject({
      status: 'done',
      outcome: 'replied',
    });
  });

  it('live owner 私聊条目缺失 senderQqId 时不注入 tools', async () => {
    const store = makeEventStore();
    const receipts = makeReceipts(store, true);
    const inbox = new SessionInbox();
    const eventId = 'evt:t1-missing-sender-qq';
    reserveOwnerReceipt(receipts, eventId, '缺少 senderQqId 的条目');
    const item: InboxItem = {
      eventId,
      sessionKey: `private:${OWNER_QQ}`,
      kind: 'private',
      speaker: null,
      senderRole: 'owner',
      origin: 'live',
      text: '缺少 senderQqId 的条目',
      quote: null,
      isAtBot: false,
      receivedAt: NOW,
    };
    inbox.enqueue(item);

    const provider = new RecordingProvider([{ text: '收到。' }], {
      supportsTools: true,
    });
    const harness = await startService({
      provider,
      store,
      receipts,
      inbox,
      configure: (config) => {
        config.webSearch.enabled = true;
        config.qq.batchWindowMs = 10;
      },
    });
    await harness.service.waitForIdle();

    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.tools).toBeUndefined();
    expect(harness.service.receipts.get(eventId)).toMatchObject({
      status: 'done',
      outcome: 'replied',
    });
  });
});

describe('T1 W4 独立验收：配置与模型迁移', () => {
  it('内置默认值为 deepseek-flash，webSearch 默认关闭且 endpoint 派生自 qq.runtimeDir', () => {
    const loaded = loadConfig(join(rootDir, 'empty-config-dir'));

    expect(loaded.source).toBe('builtin');
    expect(loaded.config.provider.default).toBe('deepseek');
    expect(loaded.config.provider.deepseek.model).toBe('deepseek-flash');
    expect(loaded.config.webSearch).toEqual({
      enabled: false,
      engines: ['baidu', 'sogou'],
      endpointFile: join(defaultRuntimeDir(), 'open-websearch.endpoint.json'),
      deepseek: {
        enabled: false,
        baseUrl: 'https://api.deepseek.com/v1/tools',
        apiKeyEnv: 'DEEPSEEK_API_KEY',
        count: 10,
        timeoutMs: 30_000,
      },
    });
  });

  it('显式 deepseek-chat 原样保留，不做隐式 fallback', () => {
    writeFileSync(
      join(rootDir, 'config.jsonc'),
      JSON.stringify({
        provider: {
          deepseek: {
            model: 'deepseek-chat',
          },
        },
      }),
      'utf8',
    );

    const loaded = loadConfig(rootDir);

    expect(loaded.config.provider.default).toBe('deepseek');
    expect(loaded.config.provider.deepseek.model).toBe('deepseek-chat');
  });

  it('webSearch.endpointFile 空值跟随 qq.runtimeDir，显式相对路径按配置目录解析', () => {
    const customRuntime = join(rootDir, 'custom-runtime');
    writeFileSync(
      join(rootDir, 'config.jsonc'),
      JSON.stringify({
        qq: { runtimeDir: customRuntime },
        webSearch: { enabled: true },
      }),
      'utf8',
    );

    expect(loadConfig(rootDir).config.webSearch).toEqual({
      enabled: true,
      engines: ['baidu', 'sogou'],
      endpointFile: join(customRuntime, 'open-websearch.endpoint.json'),
      deepseek: {
        enabled: false,
        baseUrl: 'https://api.deepseek.com/v1/tools',
        apiKeyEnv: 'DEEPSEEK_API_KEY',
        count: 10,
        timeoutMs: 30_000,
      },
    });

    writeFileSync(
      join(rootDir, 'config.jsonc'),
      JSON.stringify({
        webSearch: {
          endpointFile: './runtime/web-search.endpoint.json',
        },
      }),
      'utf8',
    );

    expect(loadConfig(rootDir).config.webSearch).toEqual({
      enabled: false,
      engines: ['baidu', 'sogou'],
      endpointFile: resolve(rootDir, 'runtime/web-search.endpoint.json'),
      deepseek: {
        enabled: false,
        baseUrl: 'https://api.deepseek.com/v1/tools',
        apiKeyEnv: 'DEEPSEEK_API_KEY',
        count: 10,
        timeoutMs: 30_000,
      },
    });
  });
});
