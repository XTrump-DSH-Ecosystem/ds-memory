import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DeepSeekProvider } from '../../src/provider/deepseek.ts';
import { DshProvider } from '../../src/provider/dsh.ts';
import {
  ProviderError,
  type ChatEvent,
  type ChatRequest,
  type ProviderMessage,
  type ToolSpec,
} from '../../src/provider/types.ts';

const ENV_NAME = 'XDS_T1_ACCEPTANCE_KEY';

interface MockServer {
  baseUrl: string;
  requests: Array<Record<string, unknown>>;
  close: () => Promise<void>;
}

type Handler = (
  res: ServerResponse,
  body: Record<string, unknown>,
  requestIndex: number,
) => void | Promise<void>;

async function startMockServer(handler: Handler): Promise<MockServer> {
  const requests: Array<Record<string, unknown>> = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : {};
      requests.push(body);
      void Promise.resolve(handler(res, body, requests.length - 1)).catch((err: unknown) => {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
        res.end(err instanceof Error ? err.message : String(err));
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function sse(value: unknown): string {
  return `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`;
}

function makeProvider(baseUrl: string): DeepSeekProvider {
  return new DeepSeekProvider({
    baseUrl,
    model: 'deepseek-flash',
    apiKeyEnv: ENV_NAME,
    timeoutMs: 5_000,
  });
}

async function collect(
  provider: DeepSeekProvider,
  request: ChatRequest,
): Promise<ChatEvent[]> {
  const events: ChatEvent[] = [];
  for await (const event of provider.chat(request, {
    signal: new AbortController().signal,
  })) {
    events.push(event);
  }
  return events;
}

function baseRequest(messages: ProviderMessage[], tools?: ToolSpec[]): ChatRequest {
  return { sessionId: 't1:acceptance', messages, tools };
}

const baseMessages: ProviderMessage[] = [
  { role: 'system', content: 'SYS' },
  { role: 'user', content: '查天气' },
];

let server: MockServer | null = null;

beforeEach(() => {
  process.env[ENV_NAME] = 't1-acceptance-not-a-real-key';
});

afterEach(async () => {
  delete process.env[ENV_NAME];
  if (server) {
    await server.close();
    server = null;
  }
});

describe('T1 W1 独立验收：DeepSeek tool_calls', () => {
  it('多 index 交错、续片 null、参数分片、reasoning_content、usage 尾块、done 唯一', async () => {
    server = await startMockServer((res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(
        sse({
          choices: [
            {
              index: 0,
              delta: {
                reasoning_content: 'R1',
                tool_calls: [
                  {
                    index: 1,
                    id: 'call_b',
                    type: 'function',
                    function: { name: 'web_fetch', arguments: '{"url":"' },
                  },
                  {
                    index: 0,
                    id: 'call_a',
                    type: 'function',
                    function: { name: 'web_search', arguments: '{"query":"' },
                  },
                ],
              },
            },
          ],
        }),
      );
      res.write(
        sse({
          choices: [
            {
              index: 0,
              delta: {
                reasoning_content: 'R2',
                tool_calls: [
                  { index: 0, id: null, type: null, function: { name: null, arguments: 'a' } },
                ],
              },
            },
          ],
        }),
      );
      res.write(
        sse({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  { index: 1, function: { arguments: 'https://example.com/x"}' } },
                  { index: 0, function: { arguments: 'a"}' } },
                ],
              },
            },
          ],
        }),
      );
      res.write(
        sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
      );
      res.write(
        sse({
          choices: [],
          usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 },
        }),
      );
      res.write(sse('[DONE]'));
      res.write(sse('[DONE]'));
      res.end();
    });

    const events = await collect(makeProvider(server.baseUrl), baseRequest(baseMessages));

    expect(events.map((event) => event.type)).toEqual(['tool_calls', 'usage', 'done']);
    expect(events.filter((event) => event.type === 'done')).toHaveLength(1);
    expect(events[0]).toEqual({
      type: 'tool_calls',
      toolCalls: [
        { id: 'call_a', name: 'web_search', argumentsText: '{"query":"aa"}' },
        {
          id: 'call_b',
          name: 'web_fetch',
          argumentsText: '{"url":"https://example.com/x"}',
        },
      ],
      reasoningContent: 'R1R2',
    });
    expect(events[1]).toEqual({
      type: 'usage',
      usage: { promptTokens: 9, completionTokens: 4, totalTokens: 13 },
    });
    expect(events.at(-1)).toEqual({ type: 'done' });
  });

  it('请求体：纯文本不带 tools；assistant tool_calls 必带 reasoning_content；tool 消息字段正确', async () => {
    server = await startMockServer((res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(sse({ choices: [{ index: 0, delta: { content: 'ok' } }] }));
      res.write(sse('[DONE]'));
      res.end();
    });
    const provider = makeProvider(server.baseUrl);

    await collect(provider, baseRequest(baseMessages));

    const tools: ToolSpec[] = [
      {
        name: 'web_search',
        description: 'search',
        parameters: { type: 'object', properties: { query: { type: 'string' } } },
      },
    ];
    const toolMessages: ProviderMessage[] = [
      ...baseMessages,
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call_1', name: 'web_search', argumentsText: '{"query":"q"}' }],
        reasoningContent: '',
      },
      { role: 'tool', content: 'tool body', toolCallId: 'call_1' },
    ];
    await collect(provider, baseRequest(toolMessages, tools));

    const plainBody = server.requests[0]!;
    expect(Object.hasOwn(plainBody, 'tools')).toBe(false);
    expect(JSON.stringify(plainBody)).not.toContain('reasoning_content');
    expect(JSON.stringify(plainBody)).not.toContain('tool_calls');

    const toolBody = server.requests[1]!;
    expect(toolBody.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'web_search',
          description: 'search',
          parameters: { type: 'object', properties: { query: { type: 'string' } } },
        },
      },
    ]);
    const sent = toolBody.messages as Array<Record<string, unknown>>;
    expect(sent[2]).toEqual({
      role: 'assistant',
      content: '',
      reasoning_content: '',
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'web_search', arguments: '{"query":"q"}' },
        },
      ],
    });
    expect(sent[3]).toEqual({
      role: 'tool',
      content: 'tool body',
      tool_call_id: 'call_1',
    });
  });

  it('缺 id/name 的 tool_calls 抛固定错误且不泄露参数', async () => {
    server = await startMockServer((res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(
        sse({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [{ index: 0, function: { arguments: '{"secret":"SENTINEL"}' } }],
              },
            },
          ],
        }),
      );
      res.write(sse('[DONE]'));
      res.end();
    });

    let caught: unknown;
    try {
      await collect(makeProvider(server.baseUrl), baseRequest(baseMessages));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ProviderError);
    expect((caught as Error).message).toBe(
      'DeepSeek tool_calls 流不完整（缺少 id/name 或 finish_reason=tool_calls 但无完整调用）',
    );
    expect((caught as Error).message).not.toContain('SENTINEL');
  });

  it('Provider.supportsTools：DeepSeek=true，DSH=false', () => {
    expect(makeProvider('http://127.0.0.1:1').supportsTools).toBe(true);
    expect(
      new DshProvider({ autoDiscover: false, profile: 'default' }).supportsTools,
    ).toBe(false);
  });

  it('CRLF 分隔符跨网络 chunk 时仍保留每个 SSE 事件', async () => {
    server = await startMockServer(async (res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      // 故意把 \r\n\r\n 拆到两个 chunk 边界：第一个 chunk 结尾是 \r\n\r，
      // 第二个 chunk 以 \n 开始。逐 chunk 做 \r\n -> \n 替换会漏掉这组分隔符。
      res.write('data: {"choices":[{"index":0,"delta":{"content":"A"}}]}\r\n\r');
      await new Promise((resolve) => setTimeout(resolve, 50));
      res.write('\ndata: {"choices":[{"index":0,"delta":{"content":"B"}}]}\r\n\r\n');
      res.write('data: [DONE]\r\n\r\n');
      res.end();
    });

    const events = await collect(makeProvider(server.baseUrl), baseRequest(baseMessages));
    const text = events
      .filter((event): event is Extract<ChatEvent, { type: 'text' }> => event.type === 'text')
      .map((event) => event.text)
      .join('');

    expect(text).toBe('AB');
    expect(events.filter((event) => event.type === 'done')).toHaveLength(1);
  });
});
