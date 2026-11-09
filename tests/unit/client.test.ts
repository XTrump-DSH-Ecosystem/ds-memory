import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { QqClient, type QqClientOptions } from '../../src/qq/client.ts';

interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  rawBody: string;
}

interface FakeGateway {
  baseUrl: string;
  requests: RecordedRequest[];
}

type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  body: unknown,
  index: number,
) => void | Promise<void>;

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (closers.length > 0) {
    const close = closers.pop()!;
    await close();
  }
});

function json(
  res: ServerResponse,
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(payload));
}

async function startGateway(handler: Handler): Promise<FakeGateway> {
  const requests: RecordedRequest[] = [];
  const server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const rawBody = Buffer.concat(chunks).toString('utf8');
      let body: unknown = null;
      if (rawBody.length > 0) {
        try {
          body = JSON.parse(rawBody);
        } catch {
          body = rawBody;
        }
      }

      requests.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body,
        rawBody,
      });

      try {
        await handler(req, res, body, requests.length - 1);
      } catch {
        if (!res.headersSent) json(res, 500, { ok: false });
        else res.end();
      }
    })();
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('假网关未获得端口');

  let closed = false;
  closers.push(async () => {
    if (closed) return;
    closed = true;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
  };
}

function makeClient(
  baseUrl: string,
  overrides: Partial<QqClientOptions> = {},
): QqClient {
  return new QqClient({
    baseUrl,
    token: 'test-token-placeholder',
    sendTimeoutMs: 1000,
    retryDelaysMs: [2000, 10000],
    sleep: async () => {},
    onWarn: () => {},
    ...overrides,
  });
}

const TARGET = { kind: 'private' as const, id: '123456789' };

describe('QqClient.send', () => {
  it('全成功：200 + ok:true，发送请求形状与 token 头正确', async () => {
    const gateway = await startGateway((_req, res) => {
      json(res, 200, {
        ok: true,
        sent: [{ messageId: '7001' }, { messageId: '7002' }, { messageId: '7003' }],
      });
    });
    const client = makeClient(gateway.baseUrl);

    const result = await client.send(TARGET, ['m1', 'm2', 'm3'], {
      replyToMessageId: 'q-9',
    });

    expect(result).toEqual({
      outcome: 'all_sent',
      sentIndexes: [0, 1, 2],
      failedIndexes: [],
      retryable: false,
      retryAfterMs: null,
      reason: null,
    });
    expect(gateway.requests).toHaveLength(1);
    expect(gateway.requests[0]!.method).toBe('POST');
    expect(gateway.requests[0]!.url).toBe('/send');
    expect(gateway.requests[0]!.headers['x-memory-token']).toBe('test-token-placeholder');
    expect(gateway.requests[0]!.body).toEqual({
      v: 1,
      target: TARGET,
      messages: ['m1', 'm2', 'm3'],
      replyToMessageId: 'q-9',
      reason: 'reply',
    });
  });

  it('200 非 429 部分失败：保留 sent 前缀，不重试', async () => {
    const gateway = await startGateway((_req, res) => {
      json(res, 200, {
        ok: false,
        sent: [{ messageId: '7001' }],
        failed: [
          { index: 1, reason: 'timeout' },
          { index: 2, reason: 'not_attempted' },
        ],
      });
    });

    const result = await makeClient(gateway.baseUrl).send(TARGET, ['m1', 'm2', 'm3']);

    expect(result).toEqual({
      outcome: 'partial',
      sentIndexes: [0],
      failedIndexes: [1, 2],
      retryable: false,
      retryAfterMs: null,
      reason: 'timeout',
    });
    expect(gateway.requests).toHaveLength(1);
  });

  it('200 首条即失败：none_sent，不重试', async () => {
    const gateway = await startGateway((_req, res) => {
      json(res, 200, {
        ok: false,
        sent: [],
        failed: [
          { index: 0, reason: 'onebot_error' },
          { index: 1, reason: 'not_attempted' },
        ],
      });
    });

    const result = await makeClient(gateway.baseUrl).send(TARGET, ['m1', 'm2']);

    expect(result.outcome).toBe('none_sent');
    expect(result.sentIndexes).toEqual([]);
    expect(result.failedIndexes).toEqual([0, 1]);
    expect(result.reason).toBe('onebot_error');
    expect(gateway.requests).toHaveLength(1);
  });

  it('429 只重试 failed[0] 到末尾，清空引用并应用响应头等待', async () => {
    const gateway = await startGateway((_req, res, _body, index) => {
      if (index === 0) {
        json(
          res,
          429,
          {
            ok: false,
            sent: [{ messageId: '7001' }],
            failed: [
              { index: 1, reason: 'rate_limited' },
              { index: 2, reason: 'not_attempted' },
            ],
          },
          { 'X-Retry-After-Ms': '1234' },
        );
        return;
      }
      json(res, 200, { ok: true, sent: [{ messageId: '7002' }, { messageId: '7003' }] });
    });
    const delays: number[] = [];
    const client = makeClient(gateway.baseUrl, {
      sleep: async (ms) => {
        delays.push(ms);
      },
    });

    const result = await client.send(TARGET, ['m1', 'm2', 'm3'], {
      replyToMessageId: 'quote-1',
    });

    expect(delays).toEqual([1234]);
    expect(gateway.requests).toHaveLength(2);
    expect(gateway.requests[1]!.body).toMatchObject({
      messages: ['m2', 'm3'],
      replyToMessageId: null,
    });
    expect(result).toEqual({
      outcome: 'all_sent',
      sentIndexes: [0, 1, 2],
      failedIndexes: [],
      retryable: false,
      retryAfterMs: null,
      reason: null,
    });
  });

  it('429 全未发送（首条 0）：重试保留 replyToMessageId', async () => {
    const gateway = await startGateway((_req, res, _body, index) => {
      if (index === 0) {
        json(
          res,
          429,
          {
            ok: false,
            sent: [],
            failed: [
              { index: 0, reason: 'rate_limited' },
              { index: 1, reason: 'not_attempted' },
            ],
          },
          { 'X-Retry-After-Ms': '0' },
        );
        return;
      }
      json(res, 200, { ok: true, sent: [{ messageId: '1' }, { messageId: '2' }] });
    });
    const delays: number[] = [];
    const client = makeClient(gateway.baseUrl, {
      sleep: async (ms) => {
        delays.push(ms);
      },
    });

    const result = await client.send(TARGET, ['m1', 'm2'], {
      replyToMessageId: 'quote-0',
    });

    expect(delays).toEqual([0]);
    expect(gateway.requests[1]!.body).toMatchObject({
      messages: ['m1', 'm2'],
      replyToMessageId: 'quote-0',
    });
    expect(result.outcome).toBe('all_sent');
  });

  it('429 缺失响应头：按 2s/10s 重试，最多 2 次', async () => {
    const gateway = await startGateway((_req, res) => {
      json(res, 429, {
        ok: false,
        sent: [],
        failed: [
          { index: 0, reason: 'rate_limited' },
          { index: 1, reason: 'not_attempted' },
        ],
      });
    });
    const delays: number[] = [];
    const client = makeClient(gateway.baseUrl, {
      sleep: async (ms) => {
        delays.push(ms);
      },
    });

    const result = await client.send(TARGET, ['m1', 'm2']);

    expect(delays).toEqual([2000, 10000]);
    expect(gateway.requests).toHaveLength(3);
    expect(result.outcome).toBe('none_sent');
    expect(result.sentIndexes).toEqual([]);
    expect(result.failedIndexes).toEqual([0, 1]);
    expect(result.retryable).toBe(false);
    expect(result.reason).toBe('rate_limited');
  });

  it('两次 429 重试累计 sentIndexes，最终全成功', async () => {
    const gateway = await startGateway((_req, res, _body, index) => {
      if (index === 0) {
        json(
          res,
          429,
          {
            ok: false,
            sent: [{ messageId: '7001' }],
            failed: [
              { index: 1, reason: 'rate_limited' },
              { index: 2, reason: 'not_attempted' },
            ],
          },
          { 'X-Retry-After-Ms': '1' },
        );
        return;
      }
      if (index === 1) {
        json(
          res,
          429,
          {
            ok: false,
            sent: [],
            failed: [
              { index: 0, reason: 'rate_limited' },
              { index: 1, reason: 'not_attempted' },
            ],
          },
          { 'X-Retry-After-Ms': '1' },
        );
        return;
      }
      json(res, 200, { ok: true, sent: [{ messageId: '7002' }, { messageId: '7003' }] });
    });
    const delays: number[] = [];
    const client = makeClient(gateway.baseUrl, {
      sleep: async (ms) => {
        delays.push(ms);
      },
    });

    const result = await client.send(TARGET, ['m1', 'm2', 'm3']);

    expect(delays).toEqual([1, 1]);
    expect(gateway.requests).toHaveLength(3);
    expect(result.outcome).toBe('all_sent');
    expect(result.sentIndexes).toEqual([0, 1, 2]);
  });

  it('429 X-Retry-After-Ms 非法：按非法响应放弃', async () => {
    const gateway = await startGateway((_req, res) => {
      json(
        res,
        429,
        {
          ok: false,
          sent: [],
          failed: [{ index: 0, reason: 'rate_limited' }],
        },
        { 'X-Retry-After-Ms': 'not-a-number' },
      );
    });
    const delays: number[] = [];
    const client = makeClient(gateway.baseUrl, {
      sleep: async (ms) => {
        delays.push(ms);
      },
    });

    const result = await client.send(TARGET, ['m1']);

    expect(delays).toEqual([]);
    expect(gateway.requests).toHaveLength(1);
    expect(result.outcome).toBe('ambiguous_failure');
    expect(result.reason).toBe('invalid_response');
  });

  it('429 X-Retry-After-Ms > 30000：立即放弃，不等待', async () => {
    const gateway = await startGateway((_req, res) => {
      json(
        res,
        429,
        {
          ok: false,
          sent: [{ messageId: '7001' }],
          failed: [{ index: 1, reason: 'rate_limited' }],
        },
        { 'X-Retry-After-Ms': '30001' },
      );
    });
    const delays: number[] = [];
    const client = makeClient(gateway.baseUrl, {
      sleep: async (ms) => {
        delays.push(ms);
      },
    });

    const result = await client.send(TARGET, ['m1', 'm2']);

    expect(delays).toEqual([]);
    expect(gateway.requests).toHaveLength(1);
    expect(result.outcome).toBe('partial');
    expect(result.sentIndexes).toEqual([0]);
    expect(result.failedIndexes).toEqual([1]);
    expect(result.retryable).toBe(false);
    expect(result.retryAfterMs).toBe(30001);
  });

  it('429 X-Retry-After-Ms = 30000：允许重试并优先使用响应头', async () => {
    const gateway = await startGateway((_req, res, _body, index) => {
      if (index === 0) {
        json(
          res,
          429,
          {
            ok: false,
            sent: [],
            failed: [{ index: 0, reason: 'rate_limited' }],
          },
          { 'X-Retry-After-Ms': '30000' },
        );
        return;
      }
      json(res, 200, { ok: true, sent: [{ messageId: '1' }] });
    });
    const delays: number[] = [];
    const client = makeClient(gateway.baseUrl, {
      sleep: async (ms) => {
        delays.push(ms);
      },
    });

    const result = await client.send(TARGET, ['m1']);

    expect(delays).toEqual([30000]);
    expect(result.outcome).toBe('all_sent');
  });

  it('重试子包局部 index 映射回原始 index', async () => {
    const gateway = await startGateway((_req, res, _body, index) => {
      if (index === 0) {
        json(
          res,
          429,
          {
            ok: false,
            sent: [{ messageId: '7001' }],
            failed: [
              { index: 1, reason: 'rate_limited' },
              { index: 2, reason: 'not_attempted' },
            ],
          },
          { 'X-Retry-After-Ms': '5' },
        );
        return;
      }
      json(res, 200, {
        ok: false,
        sent: [{ messageId: '7002' }],
        failed: [{ index: 1, reason: 'timeout' }],
      });
    });

    const result = await makeClient(gateway.baseUrl).send(TARGET, ['m1', 'm2', 'm3']);

    expect(gateway.requests[1]!.body).toMatchObject({ messages: ['m2', 'm3'] });
    expect(result).toEqual({
      outcome: 'partial',
      sentIndexes: [0, 1],
      failedIndexes: [2],
      retryable: false,
      retryAfterMs: null,
      reason: 'timeout',
    });
  });

  it.each([
    [
      '429 首失败非 rate_limited',
      429,
      {
        ok: false,
        sent: [],
        failed: [
          { index: 0, reason: 'timeout' },
          { index: 1, reason: 'not_attempted' },
        ],
      },
    ],
    [
      '200 首失败 rate_limited',
      200,
      {
        ok: false,
        sent: [],
        failed: [
          { index: 0, reason: 'rate_limited' },
          { index: 1, reason: 'not_attempted' },
        ],
      },
    ],
    ['200 缺 failed', 200, { ok: false, sent: [] }],
    ['429 缺 failed', 429, { ok: false, sent: [] }],
    [
      '200 数量不符',
      200,
      { ok: false, sent: [{ messageId: '1' }], failed: [{ index: 2, reason: 'timeout' }] },
    ],
    [
      '200 failed index 重复',
      200,
      {
        ok: false,
        sent: [],
        failed: [
          { index: 0, reason: 'timeout' },
          { index: 0, reason: 'not_attempted' },
        ],
      },
    ],
    [
      '200 failed index 越界',
      200,
      { ok: false, sent: [], failed: [{ index: 5, reason: 'timeout' }] },
    ],
  ])('%s：ambiguous_failure，不重试', async (_name, status, payload) => {
    const gateway = await startGateway((_req, res) => {
      json(res, status, payload);
    });

    const result = await makeClient(gateway.baseUrl).send(TARGET, ['m1', 'm2', 'm3']);

    expect(result.outcome).toBe('ambiguous_failure');
    expect(result.sentIndexes).toEqual([]);
    expect(result.failedIndexes).toEqual([]);
    expect(result.retryable).toBe(false);
    expect(gateway.requests).toHaveLength(1);
  });

  it('非法 JSON 响应：ambiguous_failure，不重试', async () => {
    const gateway = await startGateway((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('not-json');
    });

    const result = await makeClient(gateway.baseUrl).send(TARGET, ['m1']);

    expect(result.outcome).toBe('ambiguous_failure');
    expect(result.reason).toBe('invalid_response');
    expect(gateway.requests).toHaveLength(1);
  });

  it.each([400, 401, 413])('HTTP %i：none_sent，不重试', async (status) => {
    const gateway = await startGateway((_req, res) => {
      json(res, status, { ok: false });
    });

    const result = await makeClient(gateway.baseUrl).send(TARGET, ['m1', 'm2']);

    expect(result.outcome).toBe('none_sent');
    expect(result.sentIndexes).toEqual([]);
    expect(result.failedIndexes).toEqual([0, 1]);
    expect(result.retryable).toBe(false);
    expect(result.reason).toBe(`http_${status}`);
    expect(gateway.requests).toHaveLength(1);
  });

  it.each([500, 503])('HTTP %i：ambiguous_failure，不重发', async (status) => {
    const gateway = await startGateway((_req, res) => {
      json(res, status, { ok: false });
    });

    const result = await makeClient(gateway.baseUrl).send(TARGET, ['m1']);

    expect(result.outcome).toBe('ambiguous_failure');
    expect(result.reason).toBe('http_5xx');
    expect(gateway.requests).toHaveLength(1);
  });

  it('超时：ambiguous_failure，只请求一次', async () => {
    const gateway = await startGateway(() => {
      // 故意不响应，等待客户端超时。
    });
    const client = makeClient(gateway.baseUrl, { sendTimeoutMs: 50 });

    const result = await client.send(TARGET, ['m1']);

    expect(result.outcome).toBe('ambiguous_failure');
    expect(result.reason).toBe('timeout');
    expect(gateway.requests).toHaveLength(1);
  });

  it('网络错误：ambiguous_failure，只请求一次', async () => {
    const client = makeClient('http://127.0.0.1:1');

    const result = await client.send(TARGET, ['m1']);

    expect(result.outcome).toBe('ambiguous_failure');
    expect(result.reason).toBe('network_error');
  });

  it('空 messages：本地短路 none_sent，不调用 fetch', async () => {
    let fetchCalls = 0;
    const client = makeClient('http://127.0.0.1:803', {
      fetchImpl: async () => {
        fetchCalls += 1;
        throw new Error('不应调用 fetch');
      },
    });

    const result = await client.send(TARGET, []);

    expect(fetchCalls).toBe(0);
    expect(result).toEqual({
      outcome: 'none_sent',
      sentIndexes: [],
      failedIndexes: [],
      retryable: false,
      retryAfterMs: null,
      reason: 'empty_messages',
    });
  });

  it('仅接受 http://127.0.0.1:<port>，并保留显式默认端口', () => {
    expect(
      new QqClient({
        gatewayUrl: 'http://127.0.0.1:80/',
        token: 'test-token-placeholder',
      }).baseUrl,
    ).toBe('http://127.0.0.1:80');

    const rejected = [
      'https://127.0.0.1:803',
      'http://127.0.0.1',
      'http://127.0.0.1:0',
      'http://127.0.0.1:65536',
      'http://localhost:803',
      'http://192.168.1.10:803',
      'http://[::1]:803',
      'http://user@127.0.0.1:803',
      'http://user:pass@127.0.0.1:803',
      'http://127.0.0.1:803/path',
      'http://127.0.0.1:803?query=1',
      'http://127.0.0.1:803#fragment',
      'http://127.0.0.1:803/.',
    ];

    for (const value of rejected) {
      expect(() => makeClient(value)).toThrow(/http:\/\/127\.0\.0\.1:<port>/);
    }
  });

  it('构造错误不回显原始 URL 或其中的敏感信息', () => {
    const secretUrl =
      'http://user:super-secret-placeholder@127.0.0.1:803/?token=also-secret';

    try {
      makeClient(secretUrl);
      expect.fail('应当拒绝带 userinfo/query 的 URL');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('http://127.0.0.1:<port>');
      expect(message).not.toContain(secretUrl);
      expect(message).not.toContain('super-secret-placeholder');
      expect(message).not.toContain('also-secret');
    }
  });

  it('支持 gatewayUrl 别名，且缺少地址时构造失败', () => {
    const client = new QqClient({
      gatewayUrl: 'http://127.0.0.1:803',
      token: 'test-token-placeholder',
    });
    expect(client.baseUrl).toBe('http://127.0.0.1:803');

    expect(() => new QqClient({ token: 'test-token-placeholder' })).toThrow(/baseUrl/);
  });
});

describe('QqClient.health', () => {
  it('GET /health 免 token，解析 ok/online/selfQqId', async () => {
    const gateway = await startGateway((req, res) => {
      if (req.method === 'GET' && req.url === '/health') {
        json(res, 200, { ok: true, online: false, selfQqId: '10001' });
        return;
      }
      json(res, 404, { ok: false });
    });

    const result = await makeClient(gateway.baseUrl).health();

    expect(result).toEqual({ ok: true, online: false, selfQqId: '10001' });
    expect(gateway.requests[0]!.headers['x-memory-token']).toBeUndefined();
  });

  it('健康检查失败只告警并返回 null', async () => {
    const gateway = await startGateway((_req, res) => {
      json(res, 500, { ok: false });
    });
    const warnings: string[] = [];

    const result = await makeClient(gateway.baseUrl, {
      onWarn: (message) => warnings.push(message),
    }).health();

    expect(result).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('健康检查失败');
  });
});
