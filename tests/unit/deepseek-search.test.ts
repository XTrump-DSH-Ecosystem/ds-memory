import { describe, expect, it, vi } from 'vitest';
import { WebUrlAllowlist } from '../../src/tools/web/allowlist.ts';
import type {
  WebFetchData,
  WebSearchClientLike,
  WebSearchData,
} from '../../src/tools/web/client.ts';
import {
  DeepSeekSearchClient,
  FallbackWebSearchClient,
} from '../../src/tools/web/deepseek.ts';
import { WebToolError } from '../../src/tools/web/errors.ts';
import { createAgentWebToolRuntime } from '../../src/tools/web/tools.ts';

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function searchData(url = 'https://example.com/result'): WebSearchData {
  return {
    totalResults: 1,
    results: [
      {
        title: 'Fallback result',
        url,
        description: 'fallback description',
        source: 'example.com',
        engine: 'sogou',
      },
    ],
    partialFailures: 0,
  };
}

function fetchData(url = 'https://example.com/result'): WebFetchData {
  return {
    url,
    finalUrl: url,
    title: 'Fallback page',
    content: 'fallback content',
    contentType: 'text/html',
    truncated: false,
  };
}

class FakeClient implements WebSearchClientLike {
  search = vi.fn(async (_query: string, _options: { limit: number; signal?: AbortSignal }) => searchData());
  fetchWeb = vi.fn(async (_url: string, _options: { signal?: AbortSignal } = {}) => fetchData());
}

describe('DeepSeekSearchClient', () => {
  it('按 Search API 协议请求，并映射 summary/来源/去重', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      return jsonResponse({
        results: [
          {
            title: '米哈游新作《星布谷地》公测定档12月4日',
            url: 'https://example.com/news/1',
            snippet: '短摘要',
            summary: '长摘要：2026年12月4日全球公测',
            date: '2026-10-30',
          },
          {
            title: '重复 URL',
            url: 'https://example.com/news/1#dup',
            snippet: '重复',
          },
          {
            title: '本机地址',
            url: 'http://127.0.0.1/internal',
            snippet: '不应返回',
          },
        ],
      });
    };

    const client = new DeepSeekSearchClient({
      apiKey: 'test-key',
      baseUrl: 'https://api.deepseek.com/v1/tools',
      count: 10,
      timeoutMs: 1000,
      fetchImpl,
    });
    const data = await client.search('米哈游 2026年12月 公测', { limit: 5 });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      'https://api.deepseek.com/v1/tools/search',
    );
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.init.redirect).toBe('error');
    expect(new Headers(calls[0]?.init.headers).get('authorization')).toBe(
      'Bearer test-key',
    );
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      query: '米哈游 2026年12月 公测',
      count: 5,
      need_content: false,
    });
    expect(data).toEqual({
      totalResults: 1,
      results: [
        {
          title: '米哈游新作《星布谷地》公测定档12月4日',
          url: 'https://example.com/news/1',
          description: '短摘要\n长摘要：2026年12月4日全球公测',
          source: 'example.com',
          engine: 'deepseek',
        },
      ],
      partialFailures: 0,
    });
  });

  it('缺少凭据时返回端点不可用，交给回退层处理', async () => {
    const client = new DeepSeekSearchClient({
      apiKeyEnv: 'XDS_TEST_MISSING_DEEPSEEK_KEY',
      baseUrl: 'https://api.deepseek.com/v1/tools',
      fetchImpl: async () => jsonResponse({ results: [] }),
    });

    await expect(
      client.search('query', { limit: 5 }),
    ).rejects.toMatchObject({ code: 'web_endpoint_unavailable' });
  });

  it('HTTP 错误与超时映射为稳定错误码', async () => {
    const httpClient = new DeepSeekSearchClient({
      apiKey: 'test-key',
      baseUrl: 'https://api.deepseek.com/v1/tools',
      fetchImpl: async () => jsonResponse({ error: 'upstream' }, 500),
    });
    await expect(
      httpClient.search('query', { limit: 5 }),
    ).rejects.toMatchObject({ code: 'web_upstream_error' });

    const slowFetch: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });
    const timeoutClient = new DeepSeekSearchClient({
      apiKey: 'test-key',
      baseUrl: 'https://api.deepseek.com/v1/tools',
      timeoutMs: 20,
      fetchImpl: slowFetch,
    });
    await expect(
      timeoutClient.search('query', { limit: 5 }),
    ).rejects.toMatchObject({ code: 'web_timeout' });
  });

  it('Fetch API 请求 URL 并返回 Markdown 正文', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const client = new DeepSeekSearchClient({
      apiKey: 'test-key',
      baseUrl: 'https://api.deepseek.com/v1/tools/',
      fetchImpl: async (input, init) => {
        calls.push({
          url: String(input),
          body: JSON.parse(String(init?.body)),
        });
        return jsonResponse({ content: '# 正文' });
      },
    });

    const data = await client.fetchWeb('https://example.com/page#frag');

    expect(calls).toEqual([
      {
        url: 'https://api.deepseek.com/v1/tools/fetch',
        body: { url: 'https://example.com/page' },
      },
    ]);
    expect(data).toMatchObject({
      url: 'https://example.com/page',
      finalUrl: 'https://example.com/page',
      content: '# 正文',
      contentType: 'text/markdown',
    });
  });
});

describe('FallbackWebSearchClient', () => {
  it('首选搜索失败时回退，并标记一次部分失败', async () => {
    const primary = new FakeClient();
    primary.search.mockRejectedValueOnce(new WebToolError('web_upstream_error'));
    const fallback = new FakeClient();
    const failures: string[] = [];

    const client = new FallbackWebSearchClient({
      primary,
      fallback,
      onPrimaryFailure: (error) => failures.push(error.code),
    });
    const data = await client.search('query', { limit: 5 });

    expect(primary.search).toHaveBeenCalledOnce();
    expect(fallback.search).toHaveBeenCalledOnce();
    expect(data.partialFailures).toBe(1);
    expect(data.results[0]?.title).toBe('Fallback result');
    expect(failures).toEqual(['web_upstream_error']);
  });

  it('取消不回退；抓取失败时回退到第二抓取源', async () => {
    const primary = new FakeClient();
    primary.search.mockRejectedValueOnce(new WebToolError('web_aborted'));
    const fallback = new FakeClient();
    const client = new FallbackWebSearchClient({ primary, fallback });

    await expect(
      client.search('query', { limit: 5 }),
    ).rejects.toMatchObject({ code: 'web_aborted' });
    expect(fallback.search).not.toHaveBeenCalled();

    primary.fetchWeb.mockRejectedValueOnce(new WebToolError('web_fetch_failed'));
    const fetched = await client.fetchWeb('https://example.com/result');
    expect(fallback.fetchWeb).toHaveBeenCalledOnce();
    expect(fetched.content).toBe('fallback content');
  });

  it('primaryFetch=false 时正文直接走本地兜底，保留本地 SSRF 防护', async () => {
    const primary = new FakeClient();
    const fallback = new FakeClient();
    const client = new FallbackWebSearchClient({
      primary,
      fallback,
      primaryFetch: false,
    });

    const fetched = await client.fetchWeb('https://example.com/result');

    expect(primary.fetchWeb).not.toHaveBeenCalled();
    expect(fallback.fetchWeb).toHaveBeenCalledOnce();
    expect(fetched.content).toBe('fallback content');
  });
});

describe('DeepSeek Search 工具工厂接线', () => {
  it('没有 open-websearch 端点时也能单独使用 DeepSeek', async () => {
    process.env.XDS_TEST_DEEPSEEK_KEY = 'test-key';
    try {
      const runtime = createAgentWebToolRuntime({
        ownerSessionKey: 'cli:owner',
        deepseek: {
          enabled: true,
          baseUrl: 'https://api.deepseek.com/v1/tools',
          apiKeyEnv: 'XDS_TEST_DEEPSEEK_KEY',
          count: 10,
          timeoutMs: 1000,
        },
        allowlist: new WebUrlAllowlist(),
        fetchImpl: async () =>
          jsonResponse({
            results: [
              {
                title: '星布谷地定档',
                url: 'https://example.com/news',
                snippet: '2026年12月4日公测',
              },
            ],
          }),
      });

      const result = await runtime.execute({
        id: 'search-1',
        name: 'web_search',
        argumentsText: JSON.stringify({ query: '米哈游 12月 公测', limit: 5 }),
      });

      expect(result.ok).toBe(true);
      expect(result.content).toContain('星布谷地定档');
      expect(result.content).toContain('2026年12月4日公测');
    } finally {
      delete process.env.XDS_TEST_DEEPSEEK_KEY;
    }
  });
});
