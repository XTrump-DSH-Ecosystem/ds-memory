import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeepSeekProvider } from '../../src/provider/deepseek.ts';
import { DshProvider } from '../../src/provider/dsh.ts';
import { ProviderError } from '../../src/provider/types.ts';
import type {
  ChatEvent,
  ChatRequest,
  ProviderMessage,
  ToolSpec,
} from '../../src/provider/types.ts';

const ENV_NAME = 'XDS_TEST_API_KEY';
const INCOMPLETE_TOOL_CALLS_MESSAGE =
  'DeepSeek tool_calls 流不完整（缺少 id/name 或 finish_reason=tool_calls 但无完整调用）';

interface MockServer {
  baseUrl: string;
  close: () => Promise<void>;
}

type RequestHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  body: string,
) => void | Promise<void>;

async function startMockServer(handler: RequestHandler): Promise<MockServer> {
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      void Promise.resolve(handler(req, res, Buffer.concat(chunks).toString('utf8'))).catch(
        (err: unknown) => {
          if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
          res.end(err instanceof Error ? err.message : String(err));
        },
      );
    });
  });
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

function makeRequest(messages: ProviderMessage[], tools?: ToolSpec[]): ChatRequest {
  return { sessionId: 'cli:test', messages, tools };
}

let server: MockServer | null = null;

beforeEach(() => {
  process.env[ENV_NAME] = 'test-key-value';
});

afterEach(async () => {
  vi.unstubAllGlobals();
  delete process.env[ENV_NAME];
  if (server) {
    await server.close();
    server = null;
  }
});

describe('DeepSeek tool_calls 流聚合', () => {
  it('首片 id/type/name + 续片 null/省略 + 参数分片 + reasoning_content + usage 尾块', async () => {
    server = await startMockServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(
        sse({
          choices: [
            {
              index: 0,
              delta: {
                role: 'assistant',
                content: null,
                reasoning_content: '想',
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'web_search', arguments: '{"q":' },
                  },
                ],
              },
            },
          ],
        }),
      );
      // 续片省略 type/id/name。
      res.write(
        sse({
          choices: [
            {
              index: 0,
              delta: {
                reasoning_content: '一下',
                tool_calls: [{ index: 0, function: { arguments: '"天气"' } }],
              },
            },
          ],
        }),
      );
      // 真实形状：续片把这些字段显式置 null。
      res.write(
        sse({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: null,
                    type: null,
                    function: { name: null, arguments: '}' },
                  },
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
          usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
        }),
      );
      res.write(sse('[DONE]'));
      res.end();
    });

    const events = await collect(makeProvider(server.baseUrl), makeRequest([
      { role: 'user', content: '查天气' },
    ]));

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
      reasoningContent: '想一下',
    });
    expect(events.filter((event) => event.type === 'done')).toHaveLength(1);
    expect(events.at(-1)).toEqual({ type: 'done' });
  });

  it('多 index 交错，按 index 归并并排序', async () => {
    server = await startMockServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(
        sse({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_a',
                    type: 'function',
                    function: { name: 'web_search', arguments: '{"a":' },
                  },
                  {
                    index: 1,
                    id: 'call_b',
                    type: 'function',
                    function: { name: 'web_fetch', arguments: '{"b":' },
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
              delta: { tool_calls: [{ index: 1, function: { arguments: '2' } }] },
            },
          ],
        }),
      );
      res.write(
        sse({
          choices: [
            {
              index: 0,
              delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] },
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
                  {
                    index: 1,
                    id: null,
                    type: null,
                    function: { name: null, arguments: '}' },
                  },
                ],
              },
            },
          ],
        }),
      );
      res.write(sse('[DONE]'));
      res.end();
    });

    const events = await collect(makeProvider(server.baseUrl), makeRequest([
      { role: 'user', content: '两个工具' },
    ]));

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      type: 'tool_calls',
      toolCalls: [
        { id: 'call_a', name: 'web_search', argumentsText: '{"a":1}' },
        { id: 'call_b', name: 'web_fetch', argumentsText: '{"b":2}' },
      ],
      reasoningContent: '',
    });
    expect(events[1]).toEqual({ type: 'done' });
  });

  it('content + tool_calls 同时出现；usage 可在 done 前任意位置', async () => {
    server = await startMockServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(sse({ choices: [{ index: 0, delta: { content: '我先查。' } }] }));
      res.write(
        sse({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'web_search', arguments: '{}' },
                  },
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
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        }),
      );
      res.write(sse('[DONE]'));
      res.end();
    });

    const events = await collect(makeProvider(server.baseUrl), makeRequest([
      { role: 'user', content: '查' },
    ]));

    expect(events.map((event) => event.type)).toEqual([
      'text',
      'tool_calls',
      'usage',
      'done',
    ]);
    expect(events[0]).toEqual({ type: 'text', text: '我先查。' });
    expect(events.at(-1)).toEqual({ type: 'done' });
  });

  it('多 choices 时只消费首个 choice 的文本与工具调用', async () => {
    server = await startMockServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(
        sse({
          choices: [
            { index: 0, delta: { content: '主' } },
            { index: 1, delta: { content: '副' } },
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
                  {
                    index: 0,
                    id: 'call_main',
                    type: 'function',
                    function: { name: 'web_search', arguments: '{}' },
                  },
                ],
              },
            },
            {
              index: 1,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_other',
                    type: 'function',
                    function: { name: 'other_tool', arguments: '{}' },
                  },
                ],
              },
            },
          ],
        }),
      );
      res.write(sse('[DONE]'));
      res.end();
    });

    const events = await collect(makeProvider(server.baseUrl), makeRequest([
      { role: 'user', content: '多 choices' },
    ]));

    expect(events.map((event) => event.type)).toEqual(['text', 'tool_calls', 'done']);
    expect(events[0]).toEqual({ type: 'text', text: '主' });
    expect(events[1]).toMatchObject({
      type: 'tool_calls',
      toolCalls: [{ id: 'call_main', name: 'web_search' }],
    });
  });

  it('choices:[] 的 usage 尾块仍被提取', async () => {
    server = await startMockServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(
        sse({
          choices: [],
          usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
        }),
      );
      res.write(sse('[DONE]'));
      res.end();
    });

    const events = await collect(makeProvider(server.baseUrl), makeRequest([
      { role: 'user', content: 'usage' },
    ]));

    expect(events).toEqual([
      {
        type: 'usage',
        usage: { promptTokens: 4, completionTokens: 1, totalTokens: 5 },
      },
      { type: 'done' },
    ]);
  });

  it('无 [DONE] 的 EOF：仍发 tool_calls 与唯一 done', async () => {
    server = await startMockServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(
        sse({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_eof',
                    type: 'function',
                    function: { name: 'web_search', arguments: '{}' },
                  },
                ],
              },
            },
          ],
        }),
      );
      res.end();
    });

    const events = await collect(makeProvider(server.baseUrl), makeRequest([
      { role: 'user', content: '无 DONE' },
    ]));

    expect(events.map((event) => event.type)).toEqual(['tool_calls', 'done']);
    expect(events.filter((event) => event.type === 'done')).toHaveLength(1);
  });

  it('重复 [DONE] 只产生一个 done', async () => {
    server = await startMockServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(sse({ choices: [{ index: 0, delta: { content: '好' } }] }));
      res.write(sse('[DONE]'));
      res.write(sse('[DONE]'));
      res.end();
    });

    const events = await collect(makeProvider(server.baseUrl), makeRequest([
      { role: 'user', content: '重复 DONE' },
    ]));

    expect(events).toEqual([{ type: 'text', text: '好' }, { type: 'done' }]);
  });

  it('CRLF 分隔符跨网络 chunk（\\r\\n\\r + \\n）仍产出两个 text 且 done 唯一', async () => {
    const encoder = new TextEncoder();
    const chunks = [
      'data: {"choices":[{"index":0,"delta":{"content":"A"}}]}\r\n\r',
      '\ndata: {"choices":[{"index":0,"delta":{"content":"B"}}]}\r\n\r\ndata: [DONE]\r\n\r\n',
    ];
    let chunkIndex = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[chunkIndex];
        if (chunk === undefined) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(chunk));
        chunkIndex += 1;
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(body, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
      ),
    );

    const events = await collect(makeProvider('http://127.0.0.1:1'), makeRequest([
      { role: 'user', content: 'CRLF 边界' },
    ]));

    expect(events).toEqual([
      { type: 'text', text: 'A' },
      { type: 'text', text: 'B' },
      { type: 'done' },
    ]);
    expect(events.filter((event) => event.type === 'done')).toHaveLength(1);
  });

  it('只有 arguments 分片、缺 id/name：抛固定 ProviderError，不泄露参数', async () => {
    server = await startMockServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(
        sse({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    function: { arguments: '{"q":"SECRET' },
                  },
                ],
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
      await collect(makeProvider(server.baseUrl), makeRequest([
        { role: 'user', content: '缺字段' },
      ]));
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ProviderError);
    const message = (caught as Error).message;
    expect(message).toBe(INCOMPLETE_TOOL_CALLS_MESSAGE);
    expect(message).not.toContain('SECRET');
    expect(message).not.toContain('arguments');
  });

  it('finish_reason=tool_calls 但没有任何调用：抛固定 ProviderError', async () => {
    server = await startMockServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(
        sse({
          choices: [
            { index: 0, delta: {}, finish_reason: 'tool_calls' },
          ],
        }),
      );
      res.write(
        sse({
          choices: [],
          usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
        }),
      );
      res.write(sse('[DONE]'));
      res.end();
    });

    let caught: unknown;
    try {
      await collect(makeProvider(server.baseUrl), makeRequest([
        { role: 'user', content: '没有调用' },
      ]));
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ProviderError);
    expect((caught as Error).message).toBe(INCOMPLETE_TOOL_CALLS_MESSAGE);
  });

  it('截断 SSE 被跳过；id/name 完整的调用仍收尾且 done 唯一', async () => {
    server = await startMockServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(
        sse({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_partial',
                    type: 'function',
                    function: { name: 'web_search', arguments: '{"q":"unfinished' },
                  },
                ],
              },
            },
          ],
        }),
      );
      // 没有空行结尾的截断事件，EOF 时应被跳过。
      res.write('data: {"choices":[{"index":0,"delta":{"content":"trunc');
      res.end();
    });

    const events = await collect(makeProvider(server.baseUrl), makeRequest([
      { role: 'user', content: '不完整' },
    ]));

    expect(events.map((event) => event.type)).toEqual(['tool_calls', 'done']);
    expect(events[0]).toMatchObject({
      type: 'tool_calls',
      toolCalls: [
        {
          id: 'call_partial',
          name: 'web_search',
          argumentsText: '{"q":"unfinished',
        },
      ],
    });
    expect(events.filter((event) => event.type === 'done')).toHaveLength(1);
  });
});

describe('DeepSeek 请求体序列化', () => {
  it('纯文本请求体不含 tools / tool_calls / reasoning_content', async () => {
    const capture: { body: Record<string, unknown> | null } = { body: null };
    server = await startMockServer((_req, res, rawBody) => {
      capture.body = JSON.parse(rawBody) as Record<string, unknown>;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(sse({ choices: [{ index: 0, delta: { content: '好' } }] }));
      res.write(sse('[DONE]'));
      res.end();
    });

    const events = await collect(
      makeProvider(server.baseUrl),
      makeRequest([
        { role: 'system', content: 'SYS' },
        { role: 'user', content: '你好' },
      ]),
    );

    const body = capture.body;
    expect(body).not.toBeNull();
    if (!body) throw new Error('未捕获请求体');
    expect(Object.hasOwn(body, 'tools')).toBe(false);
    expect(body.messages).toEqual([
      { role: 'system', content: 'SYS' },
      { role: 'user', content: '你好' },
    ]);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('"tool_calls"');
    expect(serialized).not.toContain('"reasoning_content"');
    expect(events.map((event) => event.type)).toEqual(['text', 'done']);
  });

  it('assistant tool_calls 回填必带 reasoning_content（空字符串也显式发送）', async () => {
    const capture: { body: Record<string, unknown> | null } = { body: null };
    server = await startMockServer((_req, res, rawBody) => {
      capture.body = JSON.parse(rawBody) as Record<string, unknown>;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(sse({ choices: [{ index: 0, delta: { content: '最终回答' } }] }));
      res.write(sse('[DONE]'));
      res.end();
    });

    const tools: ToolSpec[] = [
      {
        name: 'web_search',
        description: '搜索网页',
        parameters: {
          type: 'object',
          properties: { q: { type: 'string' } },
          required: ['q'],
        },
      },
    ];
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
      { role: 'assistant', content: '最终回答' },
    ];

    const events = await collect(
      makeProvider(server.baseUrl),
      makeRequest(messages, tools),
    );

    const body = capture.body;
    expect(body).not.toBeNull();
    if (!body) throw new Error('未捕获请求体');
    const sent = body.messages as Array<Record<string, unknown>>;
    expect(sent[2]).toEqual({
      role: 'assistant',
      content: '',
      reasoning_content: '',
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'web_search', arguments: '{"q":"天气"}' },
        },
      ],
    });
    expect(Object.hasOwn(sent[2]!, 'reasoning_content')).toBe(true);
    expect(sent[3]).toEqual({
      role: 'tool',
      content: '搜索结果',
      tool_call_id: 'call_1',
    });
    expect(body.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'web_search',
          description: '搜索网页',
          parameters: {
            type: 'object',
            properties: { q: { type: 'string' } },
            required: ['q'],
          },
        },
      },
    ]);
    expect(events.map((event) => event.type)).toEqual(['text', 'done']);
  });
});

describe('Provider.supportsTools', () => {
  it('DeepSeek=true，DSH=false', () => {
    expect(makeProvider('http://127.0.0.1:1').supportsTools).toBe(true);
    expect(
      new DshProvider({ autoDiscover: false, profile: 'default' }).supportsTools,
    ).toBe(false);
  });
});
