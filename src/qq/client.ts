import { redact } from '../util/redact.ts';
import { validateExplicitGatewayUrl } from './discovery.ts';
import type {
  QqSendOptions,
  QqSender,
  QqTarget,
  SendResult,
} from './types.ts';

export const DEFAULT_SEND_TIMEOUT_MS = 10_000;
export const DEFAULT_RETRY_DELAYS_MS = [2_000, 10_000] as const;
export const MAX_SEND_RETRIES = 2;
export const MAX_RETRY_AFTER_MS = 30_000;

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface QqClientOptions {
  /** 网关裸 origin，必须是 http://127.0.0.1:<port>。 */
  baseUrl?: string;
  /** baseUrl 的别名，便于直接传 qq.gatewayUrl。 */
  gatewayUrl?: string;
  /** 写入 X-Memory-Token；不会进入日志或结果。 */
  token: string;
  sendTimeoutMs?: number;
  retryDelaysMs?: readonly number[];
  fetchImpl?: FetchLike;
  /** 注入等待实现（测试用）；默认 setTimeout。 */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  onWarn?: (message: string) => void;
}

export interface GatewayHealth {
  ok: boolean;
  online: boolean;
  selfQqId: string | null;
}

type FailedReason =
  | 'rate_limited'
  | 'onebot_error'
  | 'timeout'
  | 'network_error'
  | 'http_5xx'
  | 'not_attempted';

interface FailedEntry {
  index: number;
  reason: FailedReason;
}

type ParsedResponse =
  | { kind: 'success'; sentCount: number }
  | { kind: 'failure'; sentCount: number; failed: FailedEntry[] };

type AttemptResult =
  | { kind: 'success'; sentCount: number }
  | {
      kind: 'failure';
      status: 200 | 429;
      sentCount: number;
      failed: FailedEntry[];
      retryAfterMs: number | null;
    }
  | { kind: 'rejected'; reason: string }
  | { kind: 'ambiguous'; reason: string };

const FAILED_REASONS: ReadonlySet<string> = new Set([
  'rate_limited',
  'onebot_error',
  'timeout',
  'network_error',
  'http_5xx',
  'not_attempted',
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 严格解析 `{ok,sent,failed}`：
 * - sent.length + failed.length 必须等于本次请求条数；
 * - failed.index 必须从 sent.length 起连续递增（首失败 + 其后未尝试项）；
 * - 任何越界/重复/遗漏/未知 reason 都返回 null（非法响应）。
 */
function parseSendResponse(payload: unknown, attemptCount: number): ParsedResponse | null {
  if (!isObject(payload)) return null;

  if (payload.ok === true) {
    if (!Array.isArray(payload.sent) || payload.sent.length !== attemptCount) return null;
    if (!payload.sent.every(isObject)) return null;
    if (payload.failed !== undefined) {
      if (!Array.isArray(payload.failed) || payload.failed.length !== 0) return null;
    }
    return { kind: 'success', sentCount: attemptCount };
  }

  if (payload.ok !== false) return null;
  if (!Array.isArray(payload.sent) || !Array.isArray(payload.failed)) return null;
  if (!payload.sent.every(isObject)) return null;

  const sentCount = payload.sent.length;
  if (sentCount + payload.failed.length !== attemptCount) return null;
  if (payload.failed.length === 0) return null;

  const failed: FailedEntry[] = [];
  for (let i = 0; i < payload.failed.length; i += 1) {
    const entry = payload.failed[i];
    if (!isObject(entry)) return null;
    if (typeof entry.index !== 'number' || !Number.isInteger(entry.index)) return null;
    if (typeof entry.reason !== 'string' || !FAILED_REASONS.has(entry.reason)) return null;
    if (entry.index !== sentCount + i) return null;
    failed.push({ index: entry.index, reason: entry.reason as FailedReason });
  }

  return { kind: 'failure', sentCount, failed };
}

function parseRetryAfter(headers: Headers): { ok: true; value: number | null } | { ok: false } {
  const raw = headers.get('x-retry-after-ms');
  if (raw === null) return { ok: true, value: null };

  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return { ok: false };

  const value = Number(trimmed);
  if (!Number.isSafeInteger(value)) return { ok: false };
  return { ok: true, value };
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return signal?.aborted ? Promise.reject(new Error('aborted')) : Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 脑侧 QQ 发送客户端（QqSender）。
 * - 只 POST /send，不拆句、不写 L0、不接触 OneBot；
 * - 仅 429 + 首失败 rate_limited 重试尾部，最多 2 次；
 * - 子包局部 index 始终映射回原始 index；
 * - token 只放请求头，不进入日志/结果。
 */
export class QqClient implements QqSender {
  readonly baseUrl: string;
  private readonly token: string;
  private readonly sendTimeoutMs: number;
  private readonly retryDelaysMs: readonly number[];
  private readonly fetchImpl: FetchLike;
  private readonly sleepImpl: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly onWarn: (message: string) => void;

  constructor(options: QqClientOptions) {
    const rawBaseUrl = options.baseUrl ?? options.gatewayUrl;
    if (rawBaseUrl === undefined) {
      throw new Error('QqClient 需要 baseUrl 或 gatewayUrl');
    }

    const validated = validateExplicitGatewayUrl(rawBaseUrl);
    if (!validated.valid) {
      throw new Error(
        `网关地址必须是 http://127.0.0.1:<port>（${validated.reason}）`,
      );
    }

    this.baseUrl = validated.baseUrl;
    this.token = options.token;
    this.sendTimeoutMs = options.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS;
    this.retryDelaysMs =
      options.retryDelaysMs && options.retryDelaysMs.length > 0
        ? options.retryDelaysMs
        : DEFAULT_RETRY_DELAYS_MS;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.sleepImpl = options.sleep ?? defaultSleep;
    this.onWarn = options.onWarn ?? ((message) => console.warn(message));
  }

  async send(
    target: QqTarget,
    messages: string[],
    opts: QqSendOptions = {},
  ): Promise<SendResult> {
    const total = messages.length;
    if (total === 0) {
      return {
        outcome: 'none_sent',
        sentIndexes: [],
        failedIndexes: [],
        retryable: false,
        retryAfterMs: null,
        reason: 'empty_messages',
      };
    }

    const sent = new Set<number>();
    let attemptIndexes = messages.map((_, index) => index);
    let retries = 0;
    let lastRetryAfterMs: number | null = null;

    for (;;) {
      const firstOriginalIndex = attemptIndexes[0]!;
      // 重试子包首条不是原始 0 时，引用目标已不在本包，必须清空。
      const replyToMessageId =
        firstOriginalIndex === 0 ? (opts.replyToMessageId ?? null) : null;
      const attemptMessages = attemptIndexes.map((index) => messages[index]!);
      const attempt = await this.postSend(target, attemptMessages, replyToMessageId, opts);

      if (attempt.kind === 'ambiguous') {
        return {
          outcome: 'ambiguous_failure',
          sentIndexes: [...sent].sort((a, b) => a - b),
          failedIndexes: [],
          retryable: false,
          retryAfterMs: lastRetryAfterMs,
          reason: attempt.reason,
        };
      }

      if (attempt.kind === 'rejected') {
        return finalizeResult(sent, total, attempt.reason, false, null);
      }

      for (let i = 0; i < attempt.sentCount; i += 1) {
        sent.add(attemptIndexes[i]!);
      }

      if (attempt.kind === 'success') {
        return finalizeResult(sent, total, null, false, null);
      }

      if (attempt.status === 200) {
        // 非 429 的应用级失败：保留 sent 前缀，不重试。
        return finalizeResult(sent, total, attempt.failed[0]!.reason, false, null);
      }

      // 429：仅首失败 rate_limited 才走到这里。
      lastRetryAfterMs = attempt.retryAfterMs;
      const retryIndexes = attemptIndexes.slice(attempt.sentCount);

      if (retries >= MAX_SEND_RETRIES) {
        return finalizeResult(sent, total, 'rate_limited', false, lastRetryAfterMs);
      }
      if (lastRetryAfterMs !== null && lastRetryAfterMs > MAX_RETRY_AFTER_MS) {
        return finalizeResult(sent, total, 'rate_limited', false, lastRetryAfterMs);
      }

      const delay = lastRetryAfterMs ?? this.retryDelayFor(retries);
      retries += 1;
      attemptIndexes = retryIndexes;

      try {
        await this.sleepImpl(delay, opts.signal);
      } catch {
        return finalizeResult(sent, total, 'aborted', false, null);
      }
      if (opts.signal?.aborted) {
        return finalizeResult(sent, total, 'aborted', false, null);
      }
    }
  }

  /** GET /health（免 token）；失败只告警并返回 null。 */
  async health(): Promise<GatewayHealth | null> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.sendTimeoutMs);

    try {
      const response = await this.fetchImpl(`${this.baseUrl}/health`, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });

      if (!response.ok) {
        this.warn(`网关健康检查失败：HTTP ${response.status}`);
        return null;
      }

      const text = await response.text();
      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch {
        this.warn('网关健康检查失败：响应不是合法 JSON');
        return null;
      }

      if (
        !isObject(payload) ||
        typeof payload.ok !== 'boolean' ||
        typeof payload.online !== 'boolean' ||
        (payload.selfQqId !== null && typeof payload.selfQqId !== 'string')
      ) {
        this.warn('网关健康检查失败：响应形状非法');
        return null;
      }

      return {
        ok: payload.ok,
        online: payload.online,
        selfQqId: payload.selfQqId,
      };
    } catch (err) {
      const reason = timedOut
        ? 'timeout'
        : err instanceof Error
          ? redact(err.message)
          : 'network_error';
      this.warn(`网关健康检查失败：${reason}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private retryDelayFor(retry: number): number {
    const configured = this.retryDelaysMs[retry];
    if (configured !== undefined) return configured;
    return this.retryDelaysMs[this.retryDelaysMs.length - 1] ?? DEFAULT_RETRY_DELAYS_MS[0];
  }

  private warn(message: string): void {
    this.onWarn(redact(message));
  }

  private async postSend(
    target: QqTarget,
    messages: string[],
    replyToMessageId: string | null,
    opts: QqSendOptions,
  ): Promise<AttemptResult> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.sendTimeoutMs);

    const signal = opts.signal
      ? AbortSignal.any([opts.signal, controller.signal])
      : controller.signal;

    try {
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}/send`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-memory-token': this.token,
          },
          body: JSON.stringify({
            v: 1,
            target,
            messages,
            replyToMessageId,
            reason: opts.reason ?? 'reply',
          }),
          signal,
        });
      } catch {
        return { kind: 'ambiguous', reason: transportReason(opts.signal, timedOut) };
      }

      let text: string;
      try {
        text = await response.text();
      } catch {
        return { kind: 'ambiguous', reason: transportReason(opts.signal, timedOut) };
      }

      return this.interpretSendResponse(response.status, response.headers, text, messages.length);
    } finally {
      clearTimeout(timer);
    }
  }

  private interpretSendResponse(
    status: number,
    headers: Headers,
    text: string,
    attemptCount: number,
  ): AttemptResult {
    if (status === 400 || status === 401 || status === 413) {
      return { kind: 'rejected', reason: `http_${status}` };
    }
    if (status >= 500 && status <= 599) {
      return { kind: 'ambiguous', reason: 'http_5xx' };
    }
    if (status !== 200 && status !== 429) {
      return { kind: 'ambiguous', reason: `http_${status}` };
    }

    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      return { kind: 'ambiguous', reason: 'invalid_response' };
    }

    const parsed = parseSendResponse(payload, attemptCount);
    if (!parsed) {
      return { kind: 'ambiguous', reason: 'invalid_response' };
    }

    if (status === 200) {
      if (parsed.kind === 'success') {
        return { kind: 'success', sentCount: parsed.sentCount };
      }
      // 200 上出现 rate_limited 是非法组合，不重试。
      if (parsed.failed[0]!.reason === 'rate_limited') {
        return { kind: 'ambiguous', reason: 'invalid_response' };
      }
      return {
        kind: 'failure',
        status: 200,
        sentCount: parsed.sentCount,
        failed: parsed.failed,
        retryAfterMs: null,
      };
    }

    // 429：必须是非空 partial 且首失败 rate_limited。
    if (parsed.kind !== 'failure' || parsed.failed[0]!.reason !== 'rate_limited') {
      return { kind: 'ambiguous', reason: 'invalid_response' };
    }

    const retryAfter = parseRetryAfter(headers);
    if (!retryAfter.ok) {
      return { kind: 'ambiguous', reason: 'invalid_response' };
    }

    return {
      kind: 'failure',
      status: 429,
      sentCount: parsed.sentCount,
      failed: parsed.failed,
      retryAfterMs: retryAfter.value,
    };
  }
}

function transportReason(callerSignal: AbortSignal | undefined, timedOut: boolean): string {
  if (callerSignal?.aborted) return 'aborted';
  if (timedOut) return 'timeout';
  return 'network_error';
}

function finalizeResult(
  sent: ReadonlySet<number>,
  total: number,
  reason: string | null,
  retryable: boolean,
  retryAfterMs: number | null,
): SendResult {
  const sentIndexes = [...sent].sort((a, b) => a - b);
  const failedIndexes: number[] = [];
  for (let index = 0; index < total; index += 1) {
    if (!sent.has(index)) failedIndexes.push(index);
  }

  const outcome =
    sentIndexes.length === 0
      ? 'none_sent'
      : sentIndexes.length === total
        ? 'all_sent'
        : 'partial';

  return {
    outcome,
    sentIndexes,
    failedIndexes,
    retryable,
    retryAfterMs,
    reason: outcome === 'all_sent' ? null : reason,
  };
}

export function createQqClient(options: QqClientOptions): QqClient {
  return new QqClient(options);
}
