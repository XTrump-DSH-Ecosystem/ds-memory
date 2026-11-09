import type {
  WebFetchData,
  WebSearchClientLike,
  WebSearchData,
  WebSearchResultItem,
} from './client.ts';
import { WebToolError, errorCodeOf } from './errors.ts';
import { normalizeFetchableUrl } from './url-policy.ts';

const MAX_JSON_RESPONSE_CHARS = 2_000_000;

export const DEEPSEEK_SEARCH_BASE_URL = 'https://api.deepseek.com/v1/tools';
export const DEEPSEEK_SEARCH_TIMEOUT_MS = 30_000;

export interface DeepSeekSearchClientOptions {
  /** 测试注入；生产默认从 apiKeyEnv 读取。 */
  apiKey?: string;
  apiKeyEnv?: string;
  baseUrl?: string;
  count?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sourceOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./u, '');
  } catch {
    return '';
  }
}

function textField(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * DeepSeek Search/Fetch API 客户端。
 *
 * 该接口直接返回结构化结果，不额外消耗一次模型轮次；凭据缺失或上游失败时
 * 由 FallbackWebSearchClient 决定是否回退到 open-websearch。
 */
export class DeepSeekSearchClient implements WebSearchClientLike {
  private readonly apiKey: string | undefined;
  private readonly apiKeyEnv: string;
  private readonly baseUrl: string;
  private readonly count: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: DeepSeekSearchClientOptions = {}) {
    this.apiKey = options.apiKey?.trim() || undefined;
    this.apiKeyEnv = options.apiKeyEnv?.trim() || 'DEEPSEEK_API_KEY';
    this.baseUrl = (options.baseUrl?.trim() || DEEPSEEK_SEARCH_BASE_URL).replace(
      /\/+$/u,
      '',
    );
    this.count = options.count ?? 10;
    this.timeoutMs = options.timeoutMs ?? DEEPSEEK_SEARCH_TIMEOUT_MS;
    this.fetchImpl =
      options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));

    let parsed: URL;
    try {
      parsed = new URL(this.baseUrl);
    } catch {
      throw new Error('deepseek search baseUrl 必须是合法 URL');
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error('deepseek search baseUrl 只支持 http/https');
    }
    if (!Number.isInteger(this.count) || this.count < 1 || this.count > 50) {
      throw new Error('deepseek search count 必须是 1-50 的整数');
    }
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error('deepseek search timeoutMs 必须是正整数');
    }
  }

  async search(
    query: string,
    options: { limit: number; signal?: AbortSignal },
  ): Promise<WebSearchData> {
    const trimmed = query.trim();
    if (trimmed.length === 0 || trimmed.length > 1000) {
      throw new WebToolError('web_invalid_arguments');
    }
    if (!Number.isInteger(options.limit) || options.limit < 1) {
      throw new WebToolError('web_invalid_arguments');
    }

    const payload = await this.post(
      '/search',
      {
        query: trimmed,
        count: Math.min(this.count, options.limit),
        need_content: false,
      },
      options.signal,
      'web_search_failed',
    );
    const results = this.parseResults(payload, options.limit);
    return {
      totalResults: results.length,
      results,
      partialFailures: 0,
    };
  }

  async fetchWeb(
    url: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<WebFetchData> {
    const normalized = normalizeFetchableUrl(url);
    if (!normalized) throw new WebToolError('web_url_not_allowed');

    const payload = await this.post(
      '/fetch',
      { url: normalized },
      options.signal,
      'web_fetch_failed',
    );
    if (!isRecord(payload) || typeof payload.content !== 'string') {
      throw new WebToolError('web_bad_response');
    }
    return {
      url: normalized,
      finalUrl: normalized,
      title: '',
      content: payload.content,
      contentType: 'text/markdown',
      truncated: false,
    };
  }

  private resolveApiKey(): string | undefined {
    if (this.apiKey) return this.apiKey;
    const value = process.env[this.apiKeyEnv]?.trim();
    return value && value.length > 0 ? value : undefined;
  }

  private parseResults(
    payload: unknown,
    limit: number,
  ): WebSearchResultItem[] {
    if (!isRecord(payload) || !Array.isArray(payload.results)) {
      throw new WebToolError('web_bad_response');
    }

    const results: WebSearchResultItem[] = [];
    const seen = new Set<string>();
    for (const raw of payload.results) {
      if (!isRecord(raw)) continue;
      if (typeof raw.title !== 'string' || typeof raw.url !== 'string') continue;
      const normalized = normalizeFetchableUrl(raw.url);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      const summary = textField(raw.summary);
      const snippet = textField(raw.snippet);
      const descriptionParts: string[] = [];
      if (snippet.length > 0) descriptionParts.push(snippet);
      if (summary.length > 0 && summary !== snippet) {
        descriptionParts.push(summary);
      }
      results.push({
        title: raw.title,
        url: normalized,
        description: descriptionParts.join('\n'),
        source: sourceOf(normalized),
        engine: 'deepseek',
      });
      if (results.length >= limit) break;
    }
    return results;
  }

  private async post(
    path: '/search' | '/fetch',
    body: Record<string, unknown>,
    callerSignal: AbortSignal | undefined,
    networkCode: 'web_search_failed' | 'web_fetch_failed',
  ): Promise<unknown> {
    if (callerSignal?.aborted) throw new WebToolError('web_aborted');
    const apiKey = this.resolveApiKey();
    if (!apiKey) throw new WebToolError('web_endpoint_unavailable');

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, controller.signal])
      : controller.signal;

    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          accept: 'application/json',
          'content-type': 'application/json',
          'user-agent': 'xds-memory/0.1',
        },
        body: JSON.stringify(body),
        redirect: 'error',
        signal,
      });

      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new WebToolError('web_upstream_error');
      }

      const contentLength = response.headers.get('content-length');
      if (contentLength !== null) {
        const length = Number(contentLength);
        if (Number.isFinite(length) && length > MAX_JSON_RESPONSE_CHARS) {
          await response.body?.cancel().catch(() => {});
          throw new WebToolError('web_bad_response');
        }
      }

      const text = await response.text();
      if (text.length > MAX_JSON_RESPONSE_CHARS) {
        throw new WebToolError('web_bad_response');
      }
      try {
        return JSON.parse(text);
      } catch {
        throw new WebToolError('web_bad_response');
      }
    } catch (error) {
      if (callerSignal?.aborted) throw new WebToolError('web_aborted');
      if (timedOut) throw new WebToolError('web_timeout');
      if (error instanceof WebToolError) throw error;
      throw new WebToolError(networkCode);
    } finally {
      clearTimeout(timer);
    }
  }
}

export interface FallbackWebSearchClientOptions {
  primary: WebSearchClientLike;
  fallback: WebSearchClientLike;
  /** 是否允许用主源抓取正文；默认 true。 */
  primaryFetch?: boolean;
  onPrimaryFailure?: (error: WebToolError) => void;
}

/**
 * 首选搜索源失败时回退到第二搜索源。
 * 取消不触发回退；成功回退时把主源计为一次部分失败，便于模型知道结果来自降级源。
 */
export class FallbackWebSearchClient implements WebSearchClientLike {
  private readonly primary: WebSearchClientLike;
  private readonly fallback: WebSearchClientLike;
  private readonly primaryFetch: boolean;
  private readonly onPrimaryFailure: ((error: WebToolError) => void) | undefined;

  constructor(options: FallbackWebSearchClientOptions) {
    this.primary = options.primary;
    this.fallback = options.fallback;
    this.primaryFetch = options.primaryFetch !== false;
    this.onPrimaryFailure = options.onPrimaryFailure;
  }

  async search(
    query: string,
    options: { limit: number; signal?: AbortSignal },
  ): Promise<WebSearchData> {
    try {
      return await this.primary.search(query, options);
    } catch (error) {
      if (errorCodeOf(error) === 'web_aborted') throw error;
      this.notify(error);
      const data = await this.fallback.search(query, options);
      return {
        ...data,
        partialFailures: data.partialFailures + 1,
      };
    }
  }

  async fetchWeb(
    url: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<WebFetchData> {
    if (!this.primaryFetch) {
      return this.fallback.fetchWeb(url, options);
    }
    try {
      return await this.primary.fetchWeb(url, options);
    } catch (error) {
      if (errorCodeOf(error) === 'web_aborted') throw error;
      this.notify(error);
      return this.fallback.fetchWeb(url, options);
    }
  }

  private notify(error: unknown): void {
    if (!this.onPrimaryFailure) return;
    try {
      this.onPrimaryFailure(
        error instanceof WebToolError
          ? error
          : new WebToolError(errorCodeOf(error)),
      );
    } catch {
      // 日志失败不影响回退
    }
  }
}
