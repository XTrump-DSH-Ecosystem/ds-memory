import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  OpenWebSearchClient,
  WEB_SEARCH_ENDPOINT_FILENAME,
  WEB_URL_ALLOWLIST_TTL_MS,
  WebUrlAllowlist,
  createAgentWebToolRuntime,
  validateWebFetchUrl,
  type WebFetchData,
  type WebSearchClientLike,
  type WebSearchData,
  type WebToolLogEvent,
} from '../../src/tools/web/index.ts';
import { WebToolError } from '../../src/tools/web/errors.ts';

const PUBLIC_LOOKUP = async () => [{ address: '93.184.216.34', family: 4 }];

interface RequestRecord {
  method: string;
  path: string;
  body: unknown;
}

interface DaemonHarness {
  baseUrl: string;
  port: number;
  requests: RequestRecord[];
  statusData: Record<string, unknown>;
  statusCode: number;
  searchLocation: string | null;
  searchData: unknown;
  fetchData: unknown;
  close: () => Promise<void>;
}

function validStatus(baseUrl: string): Record<string, unknown> {
  return {
    daemon: 'running',
    runtime: 'ready',
    activation: 'active',
    version: '2.2.0',
    capabilities: ['search', 'fetch-web'],
    baseUrl,
    configSummary: {
      useProxy: false,
      fetchWebAllowInsecureTls: false,
      playwrightUnavailableReason: 'C:\\Users\\T1\\secret-path',
    },
  };
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function startDaemon(): Promise<DaemonHarness> {
  const daemon = {
    requests: [] as RequestRecord[],
    statusData: {} as Record<string, unknown>,
    statusCode: 200,
    searchLocation: null as string | null,
    searchData: { results: [], partialFailures: [] },
    fetchData: {},
  } as DaemonHarness;

  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const body = await readBody(req);
    daemon.requests.push({ method: req.method ?? '', path: req.url ?? '/', body });
    const sendJson = (statusCode: number, value: unknown): void => {
      res.writeHead(statusCode, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };

    if (req.url === '/status') {
      if (daemon.statusCode !== 200) {
        res.writeHead(daemon.statusCode, { 'content-type': 'text/plain' });
        res.end('status unavailable');
        return;
      }
      sendJson(200, { status: 'ok', data: daemon.statusData });
      return;
    }
    if (req.url === '/search') {
      if (daemon.searchLocation) {
        res.writeHead(302, { location: daemon.searchLocation });
        res.end();
        return;
      }
      sendJson(200, { status: 'ok', data: daemon.searchData });
      return;
    }
    if (req.url === '/fetch-web') {
      sendJson(200, { status: 'ok', data: daemon.fetchData });
      return;
    }
    sendJson(404, { status: 'error', data: null });
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  daemon.port = address.port;
  daemon.baseUrl = `http://127.0.0.1:${address.port}`;
  daemon.statusData = validStatus(daemon.baseUrl);
  daemon.close = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return daemon;
}

async function startTarget(): Promise<{
  baseUrl: string;
  requests: RequestRecord[];
  close: () => Promise<void>;
}> {
  const requests: RequestRecord[] = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method ?? '', path: req.url ?? '/', body: null });
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('should-not-be-reached');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function writeEndpoint(dir: string, port: number): string {
  const path = join(dir, WEB_SEARCH_ENDPOINT_FILENAME);
  writeFileSync(
    path,
    JSON.stringify({
      v: 1,
      name: 'open-websearch',
      host: '127.0.0.1',
      port,
      pid: process.pid,
      instanceId: 't1-acceptance-instance',
      startedAt: '2026-11-08T00:00:00.000Z',
      version: '2.2.0',
      baseUrl: `http://127.0.0.1:${port}`,
    }),
    'utf8',
  );
  return path;
}

let dir: string;
let daemon: DaemonHarness;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 't1-w2-acceptance-'));
  daemon = await startDaemon();
});

afterEach(async () => {
  await daemon.close();
  rmSync(dir, { recursive: true, force: true });
});

function makeClient(): OpenWebSearchClient {
  return new OpenWebSearchClient({
    endpointFile: join(dir, WEB_SEARCH_ENDPOINT_FILENAME),
    lookup: PUBLIC_LOOKUP,
    timeouts: { statusMs: 1_000, searchMs: 1_000, fetchMs: 1_000 },
  });
}

describe('T1 W2 独立验收：URL/DNS 安全', () => {
  it.each([
    ['http://127.0.0.1/', 'loopback_address'],
    ['http://0177.0.0.1/', 'loopback_address'],
    ['http://2130706433/', 'loopback_address'],
    ['http://0x7f.0.0.1/', 'loopback_address'],
    ['http://10.1.2.3/', 'private_address'],
    ['http://172.20.1.1/', 'private_address'],
    ['http://192.168.0.1/', 'private_address'],
    ['http://169.254.169.254/', 'link_local_address'],
    ['http://0.0.0.0/', 'unspecified_address'],
    ['http://100.64.0.1/', 'reserved_address'],
    ['http://198.18.0.1/', 'reserved_address'],
    ['http://224.0.0.1/', 'multicast_address'],
    ['http://[::1]/', 'loopback_address'],
    ['http://[fc00::1]/', 'private_address'],
    ['http://[fe80::1]/', 'link_local_address'],
    ['http://[::ffff:127.0.0.1]/', 'ipv4_mapped_ipv6'],
    ['http://[::ffff:192.168.1.1]/', 'ipv4_mapped_ipv6'],
    ['http://[64:ff9b::7f00:1]/', 'nat64_address'],
    ['http://[64:ff9b:1::1]/', 'nat64_address'],
    ['http://[2002:7f00:1::]/', 'six_to_four_address'],
    ['http://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/', 'teredo_address'],
    ['http://[2001:db8::1]/', 'reserved_address'],
    ['http://user:pass@example.com/', 'userinfo_not_allowed'],
    ['http://example.com:8443/', 'port_not_allowed'],
    ['ftp://example.com/', 'unsupported_scheme'],
    ['file:///C:/secret.txt', 'unsupported_scheme'],
  ])('拒绝 %s（%s）', async (url, reason) => {
    await expect(validateWebFetchUrl(url, { lookup: PUBLIC_LOOKUP })).resolves.toEqual({
      ok: false,
      reason,
    });
  });

  it('DNS 返回的全部地址都必须公网；空/失败/超时/取消都拒绝', async () => {
    await expect(
      validateWebFetchUrl('https://example.com/', {
        lookup: async () => [
          { address: '93.184.216.34', family: 4 },
          { address: '10.0.0.1', family: 4 },
        ],
      }),
    ).resolves.toEqual({ ok: false, reason: 'dns_non_public_address' });

    await expect(
      validateWebFetchUrl('https://example.com/', { lookup: async () => [] }),
    ).resolves.toEqual({ ok: false, reason: 'dns_empty' });

    await expect(
      validateWebFetchUrl('https://example.com/', {
        lookup: async () => {
          throw new Error('dns down');
        },
      }),
    ).resolves.toEqual({ ok: false, reason: 'dns_lookup_failed' });

    await expect(
      validateWebFetchUrl('https://example.com/', {
        lookup: () => new Promise(() => undefined),
        dnsTimeoutMs: 20,
      }),
    ).resolves.toEqual({ ok: false, reason: 'dns_timeout' });

    const controller = new AbortController();
    controller.abort();
    let lookedUp = false;
    await expect(
      validateWebFetchUrl('https://example.com/', {
        signal: controller.signal,
        lookup: async () => {
          lookedUp = true;
          return [{ address: '93.184.216.34', family: 4 }];
        },
      }),
    ).resolves.toEqual({ ok: false, reason: 'aborted' });
    expect(lookedUp).toBe(false);
  });

  it('公网域名 + 全部公网地址通过，且 normalizedUrl 去 fragment', async () => {
    const result = await validateWebFetchUrl('https://example.com/a?x=1#frag', {
      lookup: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.normalizedUrl).toBe('https://example.com/a?x=1');
      expect(result.addresses).toHaveLength(2);
    }
  });
});

describe('T1 W2 独立验收：endpoint/status/redirect', () => {
  it('status 身份字段任一不符都 fail closed', async () => {
    writeEndpoint(dir, daemon.port);
    daemon.statusData = { ...validStatus(daemon.baseUrl), version: '2.2.1' };
    await expect(makeClient().search('q', { limit: 3 })).rejects.toMatchObject({
      code: 'web_identity_mismatch',
    });

    daemon.statusData = {
      ...validStatus(daemon.baseUrl),
      configSummary: { useProxy: true, fetchWebAllowInsecureTls: false },
    };
    await expect(makeClient().search('q', { limit: 3 })).rejects.toMatchObject({
      code: 'web_identity_mismatch',
    });

    daemon.statusData = {
      ...validStatus(daemon.baseUrl),
      configSummary: { useProxy: false, fetchWebAllowInsecureTls: true },
    };
    await expect(makeClient().search('q', { limit: 3 })).rejects.toMatchObject({
      code: 'web_identity_mismatch',
    });
  });

  it('缺失 endpoint 文件时 fail closed', async () => {
    await expect(makeClient().search('q', { limit: 3 })).rejects.toMatchObject({
      code: 'web_endpoint_unavailable',
    });
  });

  it('daemon 返回重定向时不跟随到内网目标', async () => {
    const target = await startTarget();
    try {
      writeEndpoint(dir, daemon.port);
      daemon.searchLocation = `${target.baseUrl}/secret`;
      let caught: unknown;
      try {
        await makeClient().search('redirect-query', { limit: 3 });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(WebToolError);
      const code = (caught as WebToolError).code;
      expect([
        'web_search_failed',
        'web_upstream_error',
        'web_bad_response',
      ]).toContain(code);
      expect(target.requests).toHaveLength(0);
    } finally {
      await target.close();
    }
  });
});

describe('T1 W2 独立验收：allowlist/预算/日志', () => {
  it('allowlist 精确匹配含 query、去 fragment、TTL 30 分钟', () => {
    let now = 1_760_000_000_000;
    const allowlist = new WebUrlAllowlist({ now: () => now });
    allowlist.record('cli:owner', ['https://example.com/a?x=1#frag']);

    expect(allowlist.has('cli:owner', 'https://example.com/a?x=1')).toBe(true);
    expect(allowlist.has('cli:owner', 'https://example.com/a?x=2')).toBe(false);
    expect(allowlist.has('cli:owner', 'https://example.com/a?x=1#other')).toBe(true);
    expect(allowlist.has('cli:other', 'https://example.com/a?x=1')).toBe(false);

    now += WEB_URL_ALLOWLIST_TTL_MS - 1;
    expect(allowlist.has('cli:owner', 'https://example.com/a?x=1')).toBe(true);
    now += 1;
    expect(allowlist.has('cli:owner', 'https://example.com/a?x=1')).toBe(false);
  });

  it('runtime 只抓 allowlist 内 URL；finalUrl 私网拒绝；日志不含 query/正文/token', async () => {
    class FakeClient implements WebSearchClientLike {
      searchCalls: string[] = [];
      fetchCalls: string[] = [];
      searchData: WebSearchData = {
        totalResults: 1,
        results: [
          {
            title: 'T',
            url: 'https://example.com/page?token=TOKEN_SENTINEL',
            description: 'D',
            source: 'example.com',
            engine: 'fake',
          },
        ],
        partialFailures: 0,
      };
      fetchData: WebFetchData = {
        url: 'https://example.com/page?token=TOKEN_SENTINEL',
        finalUrl: 'https://example.com/page?token=TOKEN_SENTINEL',
        title: 'T',
        content: 'BODY_SENTINEL',
        contentType: 'text/html',
        truncated: false,
      };

      async search(query: string): Promise<WebSearchData> {
        this.searchCalls.push(query);
        return this.searchData;
      }

      async fetchWeb(url: string): Promise<WebFetchData> {
        this.fetchCalls.push(url);
        return this.fetchData;
      }
    }

    const client = new FakeClient();
    const logs: WebToolLogEvent[] = [];
    const runtime = createAgentWebToolRuntime({
      ownerSessionKey: 'cli:owner',
      client,
      allowlist: new WebUrlAllowlist(),
      lookup: PUBLIC_LOOKUP,
      nonceFactory: () => 't1nonce',
      logger: (event) => logs.push(event),
    });

    const search = await runtime.execute({
      id: 's1',
      name: 'web_search',
      argumentsText: JSON.stringify({ query: 'QUERY_SENTINEL' }),
    });
    expect(search.ok).toBe(true);

    const notAllowed = await runtime.execute({
      id: 'f1',
      name: 'web_fetch',
      argumentsText: JSON.stringify({ url: 'https://example.com/other' }),
    });
    expect(notAllowed).toMatchObject({ error: 'web_url_not_allowlisted' });
    expect(client.fetchCalls).toHaveLength(0);

    const allowed = await runtime.execute({
      id: 'f2',
      name: 'web_fetch',
      argumentsText: JSON.stringify({
        url: 'https://example.com/page?token=TOKEN_SENTINEL#frag',
      }),
    });
    expect(allowed.ok).toBe(true);

    client.fetchData = {
      ...client.fetchData,
      finalUrl: 'http://127.0.0.1/secret',
    };
    const finalPrivate = await runtime.execute({
      id: 'f3',
      name: 'web_fetch',
      argumentsText: JSON.stringify({
        url: 'https://example.com/page?token=TOKEN_SENTINEL',
      }),
    });
    expect(finalPrivate).toMatchObject({ error: 'web_url_not_allowed' });

    const logged = JSON.stringify(logs);
    expect(logged).not.toContain('QUERY_SENTINEL');
    expect(logged).not.toContain('TOKEN_SENTINEL');
    expect(logged).not.toContain('BODY_SENTINEL');
    expect(logged).not.toContain('127.0.0.1');
  });
});
