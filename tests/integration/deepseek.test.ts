import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DeepSeekProvider } from '../../src/provider/deepseek.ts';
import {
  ProviderAbortError,
  ProviderError,
  ProviderTimeoutError,
  type ChatEvent,
  type ChatRequest,
  type ProviderMessage,
} from '../../src/provider/types.ts';

const ENV_NAME = 'XDS_TEST_API_KEY';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface MockServer {
  baseUrl: string;
  close: () => Promise<void>;
}

async function startMockServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<MockServer> {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function makeRequest(): ChatRequest {
  return {
    sessionId: 'cli:test',
    messages: [
      { role: 'system', content: 'SYS' },
      { role: 'user', content: '你好' },
    ],
  };
}

async function collect(
  provider: DeepSeekProvider,
  request: ChatRequest,
  signal: AbortSignal,
): Promise<ChatEvent[]> {
  const events: ChatEvent[] = [];
  for await (const event of provider.chat(request, { signal })) {
    events.push(event);
  }
  return events;
}

let server: MockServer | null = null;

beforeEach(() => {
  process.env[ENV_NAME] = 'test-key-value';
});

afterEach(async () => {
  delete process.env[ENV_NAME];
  if (server) {
    await server.close();
    server = null;
  }
});

describe('DeepSeekProvider', () => {
  it('流式事件顺序正确，并提取 usage', async () => {
    server = await startMockServer(async (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"你"}}]}\n\n');
      await sleep(10);
      res.write('data: {"choices":[{"delta":{"content":"好"}}]}\n\n');
      await sleep(10);
      res.write('data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });

    const provider = new DeepSeekProvider({
      baseUrl: server.baseUrl,
      model: 'deepseek-chat',
      apiKeyEnv: ENV_NAME,
      timeoutMs: 5_000,
    });

    const events = await collect(provider, makeRequest(), new AbortController().signal);

    expect(events.map((event) => event.type)).toEqual(['text', 'text', 'usage', 'done']);
    expect(events[0]).toEqual({ type: 'text', text: '你' });
    expect(events[1]).toEqual({ type: 'text', text: '好' });
    expect(provider.usageOf(events[2]!)).toEqual({
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
    });
    expect(provider.usageOf(events[3]!)).toBeNull();
  });

  it('超时能干净退出', async () => {
    server = await startMockServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"慢"}}]}\n\n');
      // 故意不结束，让读取挂住
    });

    const provider = new DeepSeekProvider({
      baseUrl: server.baseUrl,
      model: 'deepseek-chat',
      apiKeyEnv: ENV_NAME,
      timeoutMs: 100,
    });

    await expect(
      collect(provider, makeRequest(), new AbortController().signal),
    ).rejects.toBeInstanceOf(ProviderTimeoutError);
  });

  it('慢速但持续的数据流不会被总时长截断（块间空闲超时）', async () => {
    server = await startMockServer(async (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const text of ['一', '二', '三', '四', '五']) {
        res.write(`data: {"choices":[{"delta":{"content":"${text}"}}]}\n\n`);
        await sleep(60);
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });

    const provider = new DeepSeekProvider({
      baseUrl: server.baseUrl,
      model: 'deepseek-chat',
      apiKeyEnv: ENV_NAME,
      timeoutMs: 100,
    });

    // 总时长约 300ms > timeoutMs(100)，但每块间隔 60ms < 100，不应超时。
    const events = await collect(provider, makeRequest(), new AbortController().signal);
    const texts = events.flatMap((event) => (event.type === 'text' ? [event.text] : []));

    expect(texts).toEqual(['一', '二', '三', '四', '五']);
    expect(events.at(-1)).toEqual({ type: 'done' });
  });

  it('外部中止能干净退出', async () => {
    server = await startMockServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"等"}}]}\n\n');
      // 同样不结束
    });

    const provider = new DeepSeekProvider({
      baseUrl: server.baseUrl,
      model: 'deepseek-chat',
      apiKeyEnv: ENV_NAME,
      timeoutMs: 5_000,
    });

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);

    await expect(
      collect(provider, makeRequest(), controller.signal),
    ).rejects.toBeInstanceOf(ProviderAbortError);
  });

  it('HTTP 错误带状态码且响应体脱敏', async () => {
    server = await startMockServer((_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad key sk-abc123456789xyz' }));
    });

    const provider = new DeepSeekProvider({
      baseUrl: server.baseUrl,
      model: 'deepseek-chat',
      apiKeyEnv: ENV_NAME,
      timeoutMs: 1_000,
    });

    let caught: unknown;
    try {
      await collect(provider, makeRequest(), new AbortController().signal);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ProviderError);
    const message = (caught as Error).message;
    expect(message).toContain('401');
    expect(message).not.toContain('abc123456789xyz');
  });

  it('缺少环境变量时给出明确提示', async () => {
    delete process.env[ENV_NAME];
    const provider = new DeepSeekProvider({
      baseUrl: 'http://127.0.0.1:1',
      model: 'deepseek-chat',
      apiKeyEnv: ENV_NAME,
      timeoutMs: 1_000,
    });

    await expect(
      collect(provider, makeRequest(), new AbortController().signal),
    ).rejects.toThrow(/缺少环境变量/);
  });
});

describe('DeepSeekProvider tool_calls', () => {
  it('聚合真实形状：首片 id/type/name、续片 null、参数分片、reasoning_content、usage 尾块', async () => {
    server = await startMockServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(
        'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":null,"reasoning_content":"先想","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"web_search","arguments":"{\\"q\\":"}}]}}]}\n\n',
      );
      res.write(
        'data: {"choices":[{"index":0,"delta":{"reasoning_content":"一下","tool_calls":[{"index":0,"function":{"arguments":"\\"天气\\""}}]}}]}\n\n',
      );
      res.write(
        'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":null,"type":null,"function":{"name":null,"arguments":"}"}}]}}]}\n\n',
      );
      res.write('data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n');
      res.write(
        'data: {"choices":[],"usage":{"prompt_tokens":21,"completion_tokens":9,"total_tokens":30}}\n\n',
      );
      res.write('data: [DONE]\n\n');
      res.end();
    });

    const provider = new DeepSeekProvider({
      baseUrl: server.baseUrl,
      model: 'deepseek-flash',
      apiKeyEnv: ENV_NAME,
      timeoutMs: 5_000,
    });

    const events = await collect(provider, makeRequest(), new AbortController().signal);

    expect(events.map((event) => event.type)).toEqual(['tool_calls', 'usage', 'done']);
    expect(events[0]).toEqual({
      type: 'tool_calls',
      toolCalls: [
        {
          id: 'call_1',
          name: 'web_search',
          argumentsText: '{"q":"天气"}',
        },
      ],
      reasoningContent: '先想一下',
    });
    expect(provider.usageOf(events[1]!)).toEqual({
      promptTokens: 21,
      completionTokens: 9,
      totalTokens: 30,
    });
    expect(events.filter((event) => event.type === 'done')).toHaveLength(1);
    expect(events.at(-1)).toEqual({ type: 'done' });
  });

  it('reasoningContent 修正：assistant tool_calls 回填显式带 reasoning_content（空字符串亦保留键）', async () => {
    const capture: { body: Record<string, unknown> | null } = { body: null };
    server = await startMockServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        capture.body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<
          string,
          unknown
        >;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"choices":[{"index":0,"delta":{"content":"最终回答"}}]}\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });

    const messages: ProviderMessage[] = [
      { role: 'system', content: 'SYS' },
      { role: 'user', content: '查天气' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'call_1', name: 'web_search', argumentsText: '{"q":"天气"}' },
        ],
        reasoningContent: '',
      },
      { role: 'tool', content: '搜索结果', toolCallId: 'call_1' },
    ];
    const request: ChatRequest = {
      sessionId: 'cli:test',
      messages,
      tools: [
        {
          name: 'web_search',
          description: '搜索网页',
          parameters: {
            type: 'object',
            properties: { q: { type: 'string' } },
            required: ['q'],
          },
        },
      ],
    };
    const provider = new DeepSeekProvider({
      baseUrl: server.baseUrl,
      model: 'deepseek-flash',
      apiKeyEnv: ENV_NAME,
      timeoutMs: 5_000,
    });

    const events = await collect(provider, request, new AbortController().signal);

    const body = capture.body;
    expect(body).not.toBeNull();
    if (!body) throw new Error('未捕获请求体');
    const sent = body.messages as Array<Record<string, unknown>>;
    expect(Object.hasOwn(sent[2]!, 'reasoning_content')).toBe(true);
    expect(sent[2]!.reasoning_content).toBe('');
    expect(sent[2]!.tool_calls).toEqual([
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'web_search', arguments: '{"q":"天气"}' },
      },
    ]);
    expect(sent[3]).toEqual({
      role: 'tool',
      content: '搜索结果',
      tool_call_id: 'call_1',
    });
    expect(events.map((event) => event.type)).toEqual(['text', 'done']);
  });
});
