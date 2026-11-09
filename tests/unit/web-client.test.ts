import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenWebSearchClient } from '../../src/tools/web/client.ts';
import {
  WEB_SEARCH_ENDPOINT_FILENAME,
} from '../../src/tools/web/endpoint.ts';
import { WebToolError } from '../../src/tools/web/errors.ts';

const PUBLIC_LOOKUP = async () => [
  { address: '93.184.216.34', family: 4 },
];

interface RequestRecord {
  method: string;
  path: string;
  body: unknown;
}

interface FakeDaemon {
  server: Server;
  port: number;
  baseUrl: string;
  requests: RequestRecord[];
  statusData: unknown;
  statusCode: number;
  statusDelayMs: number;
  statusRaw: string | null;
  searchData: unknown;
  searchCode: number;
  searchDelayMs: number;
  searchRaw: string | null;
  fetchData: unknown;
  fetchCode: number;
  fetchDelayMs: number;
  fetchRaw: string | null;
  close: () => Promise<void>;
}

function validStatus(baseUrl: string): Record<string, unknown> {
  return {
    daemon: 'running',
    runtime: 'ready',
    activation: 'active',
    version: '2.2.0',
    capabilities: ['search', 'fetch-web', 'fetch-csdn'],
    baseUrl,
    configSummary: {
      defaultSearchEngine: 'bing',
      searchMode: 'request',
      effectiveSearchMode: 'request',
      playwrightAvailable: false,
      useProxy: false,
      fetchWebAllowInsecureTls: false,
    },
  };
}

function payloadFor(
  raw: string | null,
  code: number,
  data: unknown,
): { code: number; raw: string } {
  return {
    code,
    raw: raw ?? JSON.stringify({ status: 'ok', data, error: null, hint: null }),
  };
}

async function startDaemon(): Promise<FakeDaemon> {
  const daemon = {} as FakeDaemon;
  daemon.requests = [];
  daemon.statusData = null;
  daemon.statusCode = 200;
  daemon.statusDelayMs = 0;
  daemon.statusRaw = null;
  daemon.searchData = null;
  daemon.searchCode = 200;
  daemon.searchDelayMs = 0;
  daemon.searchRaw = null;
  daemon.fetchData = null;
  daemon.fetchCode = 200;
  daemon.fetchDelayMs = 0;
  daemon.fetchRaw = null;

  const readBody = async (req: IncomingMessage): Promise<unknown> => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.from(chunk));
    }
    const text = Buffer.concat(chunks).toString('utf8');
    if (text.length === 0) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  };

  const respond = async (
    res: ServerResponse,
    code: number,
    raw: string,
  ): Promise<void> => {
    try {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(raw);
    } catch {
      // 客户端超时后连接可能已关闭
    }
  };

  const server = createServer(async (req, res) => {
    const path = req.url ?? '/';
    const body = await readBody(req);
    daemon.requests.push({ method: req.method ?? '', path, body });

    if (path === '/status') {
      if (daemon.statusDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, daemon.statusDelayMs));
      }
      const payload = payloadFor(
        daemon.statusRaw,
        daemon.statusCode,
        daemon.statusData,
      );
      await respond(res, payload.code, payload.raw);
      return;
    }
    if (path === '/search') {
      if (daemon.searchDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, daemon.searchDelayMs));
      }
      const payload = payloadFor(
        daemon.searchRaw,
        daemon.searchCode,
        daemon.searchData,
      );
      await respond(res, payload.code, payload.raw);
      return;
    }
    if (path === '/fetch-web') {
      if (daemon.fetchDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, daemon.fetchDelayMs));
      }
      const payload = payloadFor(
        daemon.fetchRaw,
        daemon.fetchCode,
        daemon.fetchData,
      );
      await respond(res, payload.code, payload.raw);
      return;
    }

    await respond(
      res,
      404,
      JSON.stringify({ status: 'error', data: null, error: { code: 'not_found' } }),
    );
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  daemon.server = server;
  daemon.port = address.port;
  daemon.baseUrl = `http://127.0.0.1:${address.port}`;
  daemon.statusData = validStatus(daemon.baseUrl);
  daemon.searchData = {
    results: [
      {
        title: 'Example',
        url: 'https://example.com/page?x=1#frag',
        description: 'A page',
        source: 'example.com',
        engine: 'bing',
      },
    ],
    partialFailures: [],
  };
  daemon.fetchData = {
    url: 'https://example.com/page?x=1',
    finalUrl: 'https://example.com/page?x=1',
    title: 'Example page',
    content: 'hello world',
    contentType: 'text/html',
    truncated: false,
  };

  let closed = false;
  daemon.close = async () => {
    if (closed) return;
    closed = true;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return daemon;
}

function writeEndpoint(
  dir: string,
  port: number,
  overrides: Record<string, unknown> = {},
): string {
  const filePath = join(dir, WEB_SEARCH_ENDPOINT_FILENAME);
  writeFileSync(
    filePath,
    JSON.stringify({
      v: 1,
      name: 'open-websearch',
      host: '127.0.0.1',
      port,
      pid: process.pid,
      instanceId: '11111111-1111-4111-8111-111111111111',
      startedAt: '2025-10-09T08:26:40.000Z',
      version: '2.2.0',
      baseUrl: `http://127.0.0.1:${port}`,
      ...overrides,
    }),
    'utf8',
  );
  return filePath;
}

let dir: string;
let daemon: FakeDaemon;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'xds-web-client-'));
  daemon = await startDaemon();
});

afterEach(async () => {
  await daemon.close();
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function makeClient(overrides: Partial<ConstructorParameters<typeof OpenWebSearchClient>[0]> = {}) {
  return new OpenWebSearchClient({
    endpointFile: join(dir, WEB_SEARCH_ENDPOINT_FILENAME),
    lookup: PUBLIC_LOOKUP,
    timeouts: { statusMs: 1000, searchMs: 1000, fetchMs: 1000 },
    ...overrides,
  });
}

describe('OpenWebSearchClient 正常路径', () => {
  it('status/search/fetch 使用 fake daemon，并固定 fetch 参数', async () => {
    writeEndpoint(dir, daemon.port);
    const client = makeClient();

    const search = await client.search('hello', { limit: 5 });
    expect(search.totalResults).toBe(1);
    expect(search.results[0]).toMatchObject({
      title: 'Example',
      url: 'https://example.com/page?x=1',
      description: 'A page',
    });

    const searchRequest = daemon.requests.find((request) => request.path === '/search');
    expect(searchRequest?.method).toBe('POST');
    expect(searchRequest?.body).toEqual({
      query: 'hello',
      limit: 5,
      searchMode: 'request',
    });

    const fetched = await client.fetchWeb('https://example.com/page?x=1#frag');
    expect(fetched.finalUrl).toBe('https://example.com/page?x=1');
    expect(fetched.content).toBe('hello world');

    const fetchRequest = daemon.requests.find(
      (request) => request.path === '/fetch-web',
    );
    expect(fetchRequest?.body).toEqual({
      url: 'https://example.com/page?x=1',
      maxChars: 12_000,
      readability: false,
      includeLinks: false,
      renderMode: 'request',
    });

    expect(
      daemon.requests.filter((request) => request.path === '/status'),
    ).toHaveLength(2);
  });

  it('显式 engines 按配置传给 daemon，未配置时保持旧请求形状', async () => {
    writeEndpoint(dir, daemon.port);

    await makeClient({ engines: ['baidu', 'sogou'] }).search('中文查询', {
      limit: 3,
    });
    const configured = daemon.requests.find((request) => request.path === '/search');
    expect(configured?.body).toEqual({
      query: '中文查询',
      limit: 3,
      searchMode: 'request',
      engines: ['baidu', 'sogou'],
    });

    daemon.requests.length = 0;
    await makeClient().search('plain', { limit: 3 });
    const plain = daemon.requests.find((request) => request.path === '/search');
    expect(plain?.body).toEqual({
      query: 'plain',
      limit: 3,
      searchMode: 'request',
    });
  });

  it('多引擎结果按轮转交错，避免单引擎噪声压住另一引擎首条', async () => {
    writeEndpoint(dir, daemon.port);
    daemon.searchData = {
      results: [
        { title: 'b1', url: 'https://example.com/b1', description: '', source: '', engine: 'baidu' },
        { title: 'b2', url: 'https://example.com/b2', description: '', source: '', engine: 'baidu' },
        { title: 'b3', url: 'https://example.com/b3', description: '', source: '', engine: 'baidu' },
        { title: 's1', url: 'https://example.com/s1', description: '', source: '', engine: 'sogou' },
        { title: 's2', url: 'https://example.com/s2', description: '', source: '', engine: 'sogou' },
      ],
      partialFailures: [],
    };

    const search = await makeClient({ engines: ['baidu', 'sogou'] }).search('x', {
      limit: 10,
    });

    expect(search.results.map((result) => result.title)).toEqual([
      'b1',
      's1',
      'b2',
      's2',
      'b3',
    ]);
  });

  it('非法 engines 在构造时被拒绝', () => {
    expect(() => makeClient({ engines: [] })).toThrow('engines');
    expect(() => makeClient({ engines: [''] })).toThrow('engines');
    expect(() =>
      makeClient({ engines: ['a', 'b', 'c', 'd', 'e'] }),
    ).toThrow('engines');
  });

  it('搜索结果过滤本机与非法端口 URL', async () => {
    writeEndpoint(dir, daemon.port);
    daemon.searchData = {
      results: [
        {
          title: 'local',
          url: 'http://127.0.0.1/',
          description: 'bad',
          source: '',
          engine: 'bing',
        },
        {
          title: 'port',
          url: 'http://example.com:8080/',
          description: 'bad',
          source: '',
          engine: 'bing',
        },
        {
          title: 'ok',
          url: 'https://example.com/',
          description: 'good',
          source: '',
          engine: 'bing',
        },
      ],
      partialFailures: [],
    };

    const search = await makeClient().search('x', { limit: 10 });
    expect(search.results.map((result) => result.url)).toEqual([
      'https://example.com/',
    ]);
  });
});

describe('OpenWebSearchClient /status 身份校验', () => {
  it.each<[string, Record<string, unknown>]>([
    ['daemon', { daemon: 'stopped' }],
    ['runtime', { runtime: 'starting' }],
    ['activation', { activation: 'inactive' }],
    ['version', { version: '2.2.1' }],
    ['capabilities-missing-search', { capabilities: ['fetch-web'] }],
    ['capabilities-missing-fetch', { capabilities: ['search'] }],
    ['baseUrl', { baseUrl: 'http://127.0.0.1:1' }],
    ['useProxy', { configSummary: { useProxy: true, fetchWebAllowInsecureTls: false } }],
    [
      'fetchWebAllowInsecureTls',
      { configSummary: { useProxy: false, fetchWebAllowInsecureTls: true } },
    ],
    ['configSummary-missing', { configSummary: null }],
  ])('拒绝 %s 不符的 status', async (_name, override) => {
    writeEndpoint(dir, daemon.port);
    daemon.statusData = { ...validStatus(daemon.baseUrl), ...override };

    await expect(
      makeClient().search('x', { limit: 3 }),
    ).rejects.toMatchObject({
      name: 'WebToolError',
      code: 'web_identity_mismatch',
    });
  });

  it('状态含 playwrightUnavailableReason 时不泄露到错误或日志', async () => {
    writeEndpoint(dir, daemon.port);
    const secret = 'C:\\Users\\Alice\\playwright\\secret-path';
    daemon.statusData = {
      ...validStatus(daemon.baseUrl),
      version: '2.2.1',
      configSummary: {
        useProxy: false,
        fetchWebAllowInsecureTls: false,
        playwrightAvailable: false,
        playwrightUnavailableReason: secret,
      },
    };
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    let error: unknown;
    try {
      await makeClient().search('x', { limit: 3 });
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(WebToolError);
    expect((error as WebToolError).message).not.toContain(secret);
    for (const spy of [consoleLog, consoleWarn, consoleError]) {
      expect(spy).not.toHaveBeenCalled();
    }
  });
});

describe('OpenWebSearchClient 超时、坏 envelope 与 HTTP 错误', () => {
  it('status/search/fetch 分别超时', async () => {
    writeEndpoint(dir, daemon.port);
    daemon.statusDelayMs = 100;
    await expect(
      makeClient({ timeouts: { statusMs: 20, searchMs: 20, fetchMs: 20 } }).search(
        'x',
        { limit: 3 },
      ),
    ).rejects.toMatchObject({ code: 'web_timeout' });

    daemon.statusDelayMs = 0;
    daemon.searchDelayMs = 100;
    await expect(
      makeClient({ timeouts: { statusMs: 1000, searchMs: 20, fetchMs: 20 } }).search(
        'x',
        { limit: 3 },
      ),
    ).rejects.toMatchObject({ code: 'web_timeout' });

    daemon.searchDelayMs = 0;
    daemon.fetchDelayMs = 100;
    await expect(
      makeClient({ timeouts: { statusMs: 1000, searchMs: 1000, fetchMs: 20 } }).fetchWeb(
        'https://example.com/page',
        {},
      ),
    ).rejects.toMatchObject({ code: 'web_timeout' });
  });

  it('坏 JSON / 坏 envelope 返回 web_bad_response', async () => {
    writeEndpoint(dir, daemon.port);
    daemon.statusRaw = '{broken';
    await expect(
      makeClient().search('x', { limit: 3 }),
    ).rejects.toMatchObject({ code: 'web_bad_response' });

    daemon.statusRaw = null;
    daemon.statusData = 'not-an-object';
    await expect(
      makeClient().search('x', { limit: 3 }),
    ).rejects.toMatchObject({ code: 'web_bad_response' });

    daemon.statusData = validStatus(daemon.baseUrl);
    daemon.searchRaw = JSON.stringify({ status: 'ok', data: { results: 'nope' } });
    await expect(
      makeClient().search('x', { limit: 3 }),
    ).rejects.toMatchObject({ code: 'web_bad_response' });

    daemon.searchRaw = null;
    daemon.fetchRaw = JSON.stringify({
      status: 'ok',
      data: { content: 123, finalUrl: 'https://example.com/' },
    });
    await expect(
      makeClient().fetchWeb('https://example.com/page'),
    ).rejects.toMatchObject({ code: 'web_bad_response' });

    daemon.fetchRaw = JSON.stringify({
      status: 'ok',
      data: { content: 'x' },
    });
    await expect(
      makeClient().fetchWeb('https://example.com/page'),
    ).rejects.toMatchObject({ code: 'web_bad_response' });
  });

  it('超过 2MB 的响应体在 JSON 解析前拒绝', async () => {
    writeEndpoint(dir, daemon.port);
    daemon.statusRaw = JSON.stringify({
      status: 'ok',
      data: 'x'.repeat(2_000_100),
      error: null,
    });

    await expect(
      makeClient().search('x', { limit: 3 }),
    ).rejects.toMatchObject({ code: 'web_bad_response' });
  });

  it('error envelope 与 HTTP 5xx 都映射为固定错误', async () => {
    writeEndpoint(dir, daemon.port);
    daemon.searchRaw = JSON.stringify({
      status: 'error',
      data: null,
      error: { code: 'engine_error', message: 'secret upstream detail' },
    });
    await expect(
      makeClient().search('x', { limit: 3 }),
    ).rejects.toMatchObject({ code: 'web_upstream_error' });

    daemon.searchRaw = null;
    daemon.searchCode = 500;
    let error: unknown;
    try {
      await makeClient().search('query-sentinel-123', { limit: 3 });
    } catch (err) {
      error = err;
    }
    expect(error).toMatchObject({ code: 'web_upstream_error' });
    expect((error as Error).message).not.toContain('query-sentinel-123');
    expect((error as Error).message).not.toContain('secret upstream detail');

    daemon.searchCode = 200;
    daemon.statusCode = 500;
    await expect(
      makeClient().search('x', { limit: 3 }),
    ).rejects.toMatchObject({ code: 'web_upstream_error' });

    daemon.statusCode = 200;
    daemon.fetchCode = 500;
    await expect(
      makeClient().fetchWeb('https://example.com/page'),
    ).rejects.toMatchObject({ code: 'web_upstream_error' });
  });

  it('fetch finalUrl 私网时拒绝', async () => {
    writeEndpoint(dir, daemon.port);
    daemon.fetchData = {
      url: 'https://example.com/page',
      finalUrl: 'http://127.0.0.1/secret',
      title: 'secret',
      content: 'secret',
      contentType: 'text/html',
      truncated: false,
    };
    await expect(
      makeClient().fetchWeb('https://example.com/page'),
    ).rejects.toMatchObject({ code: 'web_url_not_allowed' });
  });

  it('已 abort 的 signal 不发起请求', async () => {
    writeEndpoint(dir, daemon.port);
    const controller = new AbortController();
    controller.abort();
    await expect(
      makeClient().search('x', { limit: 3, signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'web_aborted' });
    expect(daemon.requests).toHaveLength(0);
  });
});

describe('OpenWebSearchClient endpoint 发现', () => {
  it('缺失/非法/版本不符/pid 死亡的 endpoint 都按不可用处理', async () => {
    await expect(
      makeClient().search('x', { limit: 3 }),
    ).rejects.toMatchObject({ code: 'web_endpoint_unavailable' });

    const filePath = join(dir, WEB_SEARCH_ENDPOINT_FILENAME);
    writeFileSync(filePath, '{broken', 'utf8');
    await expect(
      makeClient().search('x', { limit: 3 }),
    ).rejects.toMatchObject({ code: 'web_endpoint_unavailable' });

    writeEndpoint(dir, daemon.port, { version: '2.2.1' });
    await expect(
      makeClient().search('x', { limit: 3 }),
    ).rejects.toMatchObject({ code: 'web_endpoint_unavailable' });

    writeEndpoint(dir, daemon.port, { baseUrl: 'http://127.0.0.1:1' });
    await expect(
      makeClient().search('x', { limit: 3 }),
    ).rejects.toMatchObject({ code: 'web_endpoint_unavailable' });

    writeEndpoint(dir, daemon.port, { startedAt: 'not-a-date' });
    await expect(
      makeClient().search('x', { limit: 3 }),
    ).rejects.toMatchObject({ code: 'web_endpoint_unavailable' });

    writeEndpoint(dir, daemon.port, { startedAt: Date.now() });
    await expect(
      makeClient().search('x', { limit: 3 }),
    ).rejects.toMatchObject({ code: 'web_endpoint_unavailable' });

    writeEndpoint(dir, daemon.port);
    await expect(
      makeClient({ pidAlive: () => false }).search('x', { limit: 3 }),
    ).rejects.toMatchObject({ code: 'web_endpoint_unavailable' });

    await expect(
      makeClient({
        pidAlive: () => {
          throw new Error('pid probe failed');
        },
      }).search('x', { limit: 3 }),
    ).rejects.toMatchObject({ code: 'web_endpoint_unavailable' });
  });

  it('endpoint 文件变化后发现新的 daemon', async () => {
    const second = await startDaemon();
    try {
      writeEndpoint(dir, daemon.port);
      const client = makeClient();
      await client.search('one', { limit: 3 });
      expect(
        daemon.requests.filter((request) => request.path === '/search'),
      ).toHaveLength(1);

      writeEndpoint(dir, second.port);
      await client.search('two', { limit: 3 });
      expect(
        second.requests.filter((request) => request.path === '/search'),
      ).toHaveLength(1);
      expect(
        second.requests.find((request) => request.path === '/search')?.body,
      ).toEqual({
        query: 'two',
        limit: 3,
        searchMode: 'request',
      });
    } finally {
      await second.close();
    }
  });
});
