import { normalizeFetchableUrl } from './url-policy.ts';

export const WEB_URL_ALLOWLIST_TTL_MS = 30 * 60 * 1000;
export const WEB_URL_ALLOWLIST_MAX_ENTRIES = 64;

export interface WebUrlAllowlistOptions {
  now?: () => number;
  ttlMs?: number;
  maxEntries?: number;
}

/**
 * 进程内、按 ownerSessionKey 隔离的搜索结果 URL allowlist。
 * 精确匹配（含 query、去 fragment），TTL 30 分钟，最多 64 条，重启清空。
 */
export class WebUrlAllowlist {
  private readonly sessions = new Map<string, Map<string, number>>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(options: WebUrlAllowlistOptions = {}) {
    const ttlMs = options.ttlMs ?? WEB_URL_ALLOWLIST_TTL_MS;
    const maxEntries = options.maxEntries ?? WEB_URL_ALLOWLIST_MAX_ENTRIES;
    if (!Number.isInteger(ttlMs) || ttlMs <= 0) {
      throw new Error('ttlMs 必须是正整数');
    }
    if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
      throw new Error('maxEntries 必须是正整数');
    }

    this.now = options.now ?? Date.now;
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
  }

  record(sessionKey: string, urls: readonly string[]): readonly string[] {
    if (sessionKey.length === 0) throw new Error('sessionKey 不能为空');

    const entries = this.getEntries(sessionKey);
    const recorded: string[] = [];
    const seen = new Set<string>();

    for (const raw of urls) {
      const normalized = normalizeFetchableUrl(raw);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      entries.delete(normalized);
      entries.set(normalized, this.now());
      recorded.push(normalized);
    }

    for (const key of entries.keys()) {
      if (entries.size <= this.maxEntries) break;
      entries.delete(key);
    }

    if (entries.size === 0) this.sessions.delete(sessionKey);
    return recorded;
  }

  has(sessionKey: string, rawUrl: string): boolean {
    const normalized = normalizeFetchableUrl(rawUrl);
    if (!normalized) return false;

    const entries = this.getEntries(sessionKey);
    const addedAt = entries.get(normalized);
    if (addedAt === undefined) {
      if (entries.size === 0) this.sessions.delete(sessionKey);
      return false;
    }

    if (this.now() - addedAt >= this.ttlMs) {
      entries.delete(normalized);
      if (entries.size === 0) this.sessions.delete(sessionKey);
      return false;
    }
    return true;
  }

  size(sessionKey: string): number {
    const entries = this.getEntries(sessionKey);
    if (entries.size === 0) {
      this.sessions.delete(sessionKey);
      return 0;
    }
    return entries.size;
  }

  clear(sessionKey?: string): void {
    if (sessionKey === undefined) {
      this.sessions.clear();
      return;
    }
    this.sessions.delete(sessionKey);
  }

  private getEntries(sessionKey: string): Map<string, number> {
    let entries = this.sessions.get(sessionKey);
    if (!entries) {
      entries = new Map();
      this.sessions.set(sessionKey, entries);
    }

    const now = this.now();
    for (const [url, addedAt] of entries) {
      if (now - addedAt >= this.ttlMs) entries.delete(url);
    }
    return entries;
  }
}

/** 生产默认共享实例；同进程跨轮持久，进程退出自然清空。 */
export const processWebUrlAllowlist = new WebUrlAllowlist();
