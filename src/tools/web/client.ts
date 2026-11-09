import { WEB_TOOL_MAX_RESULT_CHARS } from './budget.ts';
import {
  readWebSearchEndpoint,
  type WebSearchEndpoint,
} from './endpoint.ts';
import { WebToolError } from './errors.ts';
import {
  normalizeFetchableUrl,
  validateWebFetchUrl,
  type LookupFn,
} from './url-policy.ts';

export const WEB_STATUS_TIMEOUT_MS = 5_000;
export const WEB_SEARCH_TIMEOUT_MS = 20_000;
export const WEB_FETCH_TIMEOUT_MS = 30_000;
export const WEB_ROUND_TIMEOUT_MS = 120_000;

const MAX_JSON_RESPONSE_CHARS = 2_000_000;

async function readBoundedText(
  response: Response,
  maxBytes: number,
): Promise<string> {
  if (response.body === null) return '';

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new WebToolError('web_bad_response');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString('utf8');
}

export interface WebSearchResultItem {
  title: string;
  url: string;
  description: string;
  source: string;
  engine: string;
}

export interface WebSearchData {
  totalResults: number;
  results: WebSearchResultItem[];
  partialFailures: number;
}

export interface WebFetchData {
  url: string;
  finalUrl: string;
  title: string;
  content: string;
  contentType: string;
  truncated: boolean;
}

export interface WebClientTimeouts {
  statusMs: number;
  searchMs: number;
  fetchMs: number;
}

export interface WebSearchClientOptions {
  endpointFile: string;
  /** 传给 open-websearch 的搜索引擎列表；不传则由 daemon 默认值决定。 */
  engines?: readonly string[];
  fetchImpl?: typeof fetch;
  lookup?: LookupFn;
  timeouts?: Partial<WebClientTimeouts>;
  pidAlive?: (pid: number) => boolean;
}

export interface WebSearchClientLike {
  search(
    query: string,
    options: { limit: number; signal?: AbortSignal },
  ): Promise<WebSearchData>;
  fetchWeb(url: string, options?: { signal?: AbortSignal }): Promise<WebFetchData>;
}

type NetworkErrorCode =
  | 'web_daemon_unavailable'
  | 'web_search_failed'
  | 'web_fetch_failed';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidStatus(
  data: Record<string, unknown>,
  endpoint: WebSearchEndpoint,
): boolean {
  if (
    data.daemon !== 'running' ||
    data.runtime !== 'ready' ||
    data.activation !== 'active' ||
    data.version !== '2.2.0'
  ) {
    return false;
  }

  const capabilities = data.capabilities;
  if (!Array.isArray(capabilities)) return false;
  if (!capabilities.includes('search') || !capabilities.includes('fetch-web')) {
    return false;
  }
  if (data.baseUrl !== endpoint.baseUrl) return false;
  if (!isRecord(data.configSummary)) return false;
  if (data.configSummary.useProxy !== false) return false;
  if (data.configSummary.fetchWebAllowInsecureTls !== false) return false;
  return true;
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // 丢弃响应体失败不影响已确定的错误码
  }
}

export class OpenWebSearchClient implements WebSearchClientLike {
  private readonly endpointFile: string;
  private readonly engines: readonly string[];
  private readonly fetchImpl: typeof fetch;
  private readonly lookup: LookupFn | undefined;
  private readonly timeouts: WebClientTimeouts;
  private readonly pidAlive: ((pid: number) => boolean) | undefined;

  constructor(options: WebSearchClientOptions) {
    if (options.endpointFile.trim().length === 0) {
      throw new Error('endpointFile 不能为空');
    }

    if (options.engines !== undefined) {
      if (
        !Array.isArray(options.engines) ||
        options.engines.length === 0 ||
        options.engines.length > 4 ||
        options.engines.some(
          (engine) =>
            typeof engine !== 'string' ||
            engine.trim().length === 0 ||
            engine.length > 32,
        )
      ) {
        throw new Error('engines 必须是 1-4 个非空引擎名');
      }
    }

    this.endpointFile = options.endpointFile;
    this.engines = options.engines ? [...options.engines] : [];
    this.fetchImpl =
      options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    this.lookup = options.lookup;
    this.pidAlive = options.pidAlive;
    this.timeouts = {
      statusMs: options.timeouts?.statusMs ?? WEB_STATUS_TIMEOUT_MS,
      searchMs: options.timeouts?.searchMs ?? WEB_SEARCH_TIMEOUT_MS,
      fetchMs: options.timeouts?.fetchMs ?? WEB_FETCH_TIMEOUT_MS,
    };

    for (const [name, value] of Object.entries(this.timeouts)) {
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`${name} 必须是正整数`);
      }
    }
  }

  async search(
    query: string,
    options: { limit: number; signal?: AbortSignal },
  ): Promise<WebSearchData> {
    const trimmed = query.trim();
    if (trimmed.length === 0) throw new WebToolError('web_invalid_arguments');
    if (trimmed.length > 1000) throw new WebToolError('web_invalid_arguments');
    if (
      !Number.isInteger(options.limit) ||
      options.limit < 1 ||
      options.limit > 50
    ) {
      throw new WebToolError('web_invalid_arguments');
    }

    const endpoint = await this.ensureReady(options.signal);
    const requestBody: Record<string, unknown> = {
      query: trimmed,
      limit: options.limit,
      searchMode: 'request',
    };
    if (this.engines.length > 0) requestBody.engines = [...this.engines];

    const body = await this.requestJson(
      `${endpoint.baseUrl}/search`,
      {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      },
      this.timeouts.searchMs,
      options.signal,
      'web_search_failed',
    );

    const data = this.successData(body);
    if (!data || !Array.isArray(data.results)) {
      throw new WebToolError('web_bad_response');
    }
    return parseSearchData(data);
  }

  async fetchWeb(
    url: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<WebFetchData> {
    const normalized = normalizeFetchableUrl(url);
    if (!normalized) throw new WebToolError('web_url_not_allowed');

    const endpoint = await this.ensureReady(options.signal);
    const body = await this.requestJson(
      `${endpoint.baseUrl}/fetch-web`,
      {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          url: normalized,
          maxChars: WEB_TOOL_MAX_RESULT_CHARS,
          readability: false,
          includeLinks: false,
          renderMode: 'request',
        }),
      },
      this.timeouts.fetchMs,
      options.signal,
      'web_fetch_failed',
    );

    const data = this.successData(body);
    if (
      !data ||
      typeof data.content !== 'string' ||
      typeof data.finalUrl !== 'string' ||
      data.finalUrl.length === 0
    ) {
      throw new WebToolError('web_bad_response');
    }

    const finalPolicy = await validateWebFetchUrl(data.finalUrl, {
      lookup: this.lookup,
      signal: options.signal,
    });
    if (!finalPolicy.ok) {
      if (finalPolicy.reason === 'aborted') {
        throw new WebToolError('web_aborted');
      }
      if (finalPolicy.reason === 'dns_timeout') {
        throw new WebToolError('web_timeout');
      }
      throw new WebToolError('web_url_not_allowed');
    }

    return {
      url: normalized,
      finalUrl: finalPolicy.normalizedUrl,
      title: typeof data.title === 'string' ? data.title : '',
      content: data.content,
      contentType: typeof data.contentType === 'string' ? data.contentType : '',
      truncated: data.truncated === true,
    };
  }

  private async ensureReady(signal?: AbortSignal): Promise<WebSearchEndpoint> {
    if (signal?.aborted) throw new WebToolError('web_aborted');

    const parsed = readWebSearchEndpoint(this.endpointFile, {
      pidAlive: this.pidAlive,
    });
    if (!parsed.valid) {
      throw new WebToolError('web_endpoint_unavailable');
    }

    await this.checkStatus(parsed.endpoint, signal);
    return parsed.endpoint;
  }

  private async checkStatus(
    endpoint: WebSearchEndpoint,
    signal?: AbortSignal,
  ): Promise<void> {
    const body = await this.requestJson(
      `${endpoint.baseUrl}/status`,
      {
        method: 'GET',
        headers: { accept: 'application/json' },
      },
      this.timeouts.statusMs,
      signal,
      'web_daemon_unavailable',
    );

    if (!isRecord(body) || body.status !== 'ok' || !isRecord(body.data)) {
      throw new WebToolError('web_bad_response');
    }
    if (!isValidStatus(body.data, endpoint)) {
      throw new WebToolError('web_identity_mismatch');
    }
  }

  private successData(body: unknown): Record<string, unknown> | null {
    if (!isRecord(body)) return null;
    if (body.status === 'error') {
      throw new WebToolError('web_upstream_error');
    }
    if (body.status !== 'ok' || !isRecord(body.data)) return null;
    return body.data;
  }

  private async requestJson(
    url: string,
    init: RequestInit,
    timeoutMs: number,
    callerSignal: AbortSignal | undefined,
    networkCode: NetworkErrorCode,
  ): Promise<unknown> {
    if (callerSignal?.aborted) throw new WebToolError('web_aborted');

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, controller.signal])
      : controller.signal;

    try {
      const response = await this.fetchImpl(url, {
        ...init,
        signal,
        redirect: 'error',
      });

      if (!response.ok) {
        await discardBody(response);
        throw new WebToolError('web_upstream_error');
      }

      const contentLength = response.headers.get('content-length');
      if (contentLength !== null) {
        const length = Number(contentLength);
        if (Number.isFinite(length) && length > MAX_JSON_RESPONSE_CHARS) {
          await discardBody(response);
          throw new WebToolError('web_bad_response');
        }
      }

      const text = await readBoundedText(response, MAX_JSON_RESPONSE_CHARS);

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

function parseSearchData(data: Record<string, unknown>): WebSearchData {
  const rawResults = data.results as unknown[];
  const results: WebSearchResultItem[] = [];
  const seen = new Set<string>();

  for (const raw of rawResults) {
    if (!isRecord(raw)) continue;
    if (
      typeof raw.title !== 'string' ||
      typeof raw.url !== 'string' ||
      typeof raw.description !== 'string'
    ) {
      continue;
    }
    const normalized = normalizeFetchableUrl(raw.url);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    results.push({
      title: raw.title,
      url: normalized,
      description: raw.description,
      source: typeof raw.source === 'string' ? raw.source : '',
      engine: typeof raw.engine === 'string' ? raw.engine : '',
    });
  }

  const interleaved = interleaveByEngine(results);
  return {
    totalResults: interleaved.length,
    results: interleaved,
    partialFailures: Array.isArray(data.partialFailures)
      ? data.partialFailures.length
      : 0,
  };
}

/**
 * 多引擎结果按轮转交错，保留各引擎内部的原始排序。
 * open-websearch 会把同一引擎的结果连续拼接；若某个引擎返回噪声，另一个
 * 引擎的首条正确结果可能被压到很后。轮转只改变展示顺序，不改变相关性判断。
 */
function interleaveByEngine(
  results: readonly WebSearchResultItem[],
): WebSearchResultItem[] {
  if (results.length < 2) return [...results];

  const groups = new Map<string, WebSearchResultItem[]>();
  for (const result of results) {
    const key = result.engine.trim();
    const group = groups.get(key);
    if (group) {
      group.push(result);
    } else {
      groups.set(key, [result]);
    }
  }
  if (groups.size < 2) return [...results];

  const queues = [...groups.values()];
  const merged: WebSearchResultItem[] = [];
  for (let index = 0; merged.length < results.length; index += 1) {
    for (const queue of queues) {
      const result = queue[index];
      if (result) merged.push(result);
    }
  }
  return merged;
}
