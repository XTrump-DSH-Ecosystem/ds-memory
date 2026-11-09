export interface MemberReplyGate {
  /** 等待最小间隔并占用一个配额；超出一分钟上限时返回 false。 */
  acquire(scope: string, signal: AbortSignal): Promise<boolean>;
}

export interface MemberReplyLimiterOptions {
  minIntervalMs: number;
  maxPerMinute: number;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const WINDOW_MS = 60_000;

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('成员回复限流等待已取消');
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortReason(signal));

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 普通群成员回复节流（按群会话隔离）：
 * - 相邻两次发送至少间隔 minIntervalMs；
 * - 任意 60 秒窗口最多 maxPerMinute 次；
 * - 只由成员回合调用，owner 回合不经过这里。
 */
export class MemberReplyLimiter implements MemberReplyGate {
  private readonly minIntervalMs: number;
  private readonly maxPerMinute: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly sentAt = new Map<string, number[]>();

  constructor(options: MemberReplyLimiterOptions) {
    this.minIntervalMs = Math.max(0, Math.floor(options.minIntervalMs));
    this.maxPerMinute = Math.max(1, Math.floor(options.maxPerMinute));
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
  }

  /** 不占用配额，只判断当前窗口是否还允许开始一次成员回复。 */
  canStart(scope: string, now: number = this.now()): boolean {
    return this.recent(scope, now).length < this.maxPerMinute;
  }

  async acquire(scope: string, signal: AbortSignal): Promise<boolean> {
    let now = this.now();
    let recent = this.recent(scope, now);
    if (recent.length >= this.maxPerMinute) return false;

    const last = recent.at(-1);
    const waitMs = last === undefined ? 0 : Math.max(0, this.minIntervalMs - (now - last));
    if (waitMs > 0) await this.sleep(waitMs, signal);

    now = this.now();
    recent = this.recent(scope, now);
    if (recent.length >= this.maxPerMinute) return false;

    recent.push(now);
    this.sentAt.set(scope, recent);
    return true;
  }

  private recent(scope: string, now: number): number[] {
    const values = this.sentAt.get(scope) ?? [];
    const recent = values.filter((at) => now - at < WINDOW_MS);
    if (recent.length === 0) this.sentAt.delete(scope);
    else this.sentAt.set(scope, recent);
    return recent;
  }
}
