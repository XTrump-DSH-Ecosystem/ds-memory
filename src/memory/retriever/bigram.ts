import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { EventStore, RawRecord } from '../store.ts';
import { truncateText } from '../../util/string.ts';
import { formatInjection, type MemoryChunk, type Retriever, type SearchOptions } from './types.ts';

/** 检索引擎 id；embedding 是 P3 的事。 */
export const BIGRAM_ID = 'bigram' as const;

/** 单条注入文本上限（字符）。 */
export const CHUNK_TEXT_LIMIT = 400;

/** 去重用的前缀长度：同文本前 80 字相同即视为同一条。 */
const DEDUPE_PREFIX = 80;

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;
const ALNUM_RE = /[a-zA-Z0-9]/;

interface Doc {
  id: string;
  text: string;
  at: number;
  who: string;
  sessionKey: string;
  grams: Set<string>;
}

/** 给 HybridRetriever 复用的只读文档视图；不暴露可变索引。 */
export interface LexicalDoc {
  readonly id: string;
  readonly text: string;
  readonly at: number;
  readonly who: string;
  readonly sessionKey: string;
  readonly grams: ReadonlySet<string>;
}

/**
 * 中文 bigram + 英文/数字整词的倒排索引。
 *
 * - 中文按 2 字滑窗切 gram（单字 run 保留单字）
 * - 英文/数字连续段整体 lower 后作为一个词
 * - 标点与空白当分隔符
 *
 * 这套 gram 同时被 facts 的自动复习钩子复用（复用 retriever 的 gram 函数）。
 */
export function grams(text: string): Set<string> {
  const out = new Set<string>();
  let cjk: string[] = [];
  let word = '';

  const flushCjk = (): void => {
    if (cjk.length === 1) out.add(cjk[0]!);
    for (let i = 0; i + 1 < cjk.length; i += 1) out.add(cjk[i]! + cjk[i + 1]!);
    cjk = [];
  };
  const flushWord = (): void => {
    if (word.length > 0) out.add(word);
    word = '';
  };

  for (const ch of text) {
    if (CJK_RE.test(ch)) {
      flushWord();
      cjk.push(ch);
      continue;
    }
    flushCjk();
    if (ALNUM_RE.test(ch)) {
      word += ch.toLowerCase();
    } else {
      flushWord();
    }
  }
  flushCjk();
  flushWord();

  return out;
}

/**
 * L0 原文的 bigram 检索器。
 * - 索引 user / assistant 记录，严格按 sessionKey 隔离
 * - 懒加载：分片文件的 mtime/size 签名变化才重建索引
 * - 打分 = 命中覆盖率（命中 query gram 数 / query gram 总数）+ 30 天内近因微调
 */
export class BigramRetriever implements Retriever {
  readonly id = BIGRAM_ID;

  private readonly store: EventStore;
  private readonly now: () => number;
  private readonly ownerQQ: number;

  private signature = '';
  private docs: Doc[] = [];
  private inverted = new Map<string, Set<number>>();

  constructor(options: { store: EventStore; now?: () => number; ownerQQ?: number }) {
    this.store = options.store;
    this.now = options.now ?? Date.now;
    this.ownerQQ = options.ownerQQ ?? 0;
  }

  async search(query: string, opts: SearchOptions): Promise<MemoryChunk[]> {
    const queryGrams = grams(query.trim());
    if (queryGrams.size === 0) return [];
    this.rebuildIfStale();

    const matched = new Map<number, number>();
    for (const gram of queryGrams) {
      const docIds = this.inverted.get(gram);
      if (!docIds) continue;
      for (const index of docIds) {
        const doc = this.docs[index];
        if (!doc || doc.sessionKey !== opts.sessionKey) continue;
        matched.set(index, (matched.get(index) ?? 0) + 1);
      }
    }

    const now = this.now();
    const scored: Array<{ doc: Doc; at: number; score: number; text: string }> = [];
    for (const [index, hits] of matched) {
      const doc = this.docs[index]!;
      const coverage = hits / queryGrams.size;
      if (coverage <= 0) continue;

      const ageDays = (now - doc.at) / 86_400_000;
      // 近因只做排序微调（最多 +0.05），不改变覆盖率的主导地位。
      const recency = ageDays >= 0 && ageDays <= 30 ? 0.05 * (1 - ageDays / 30) : 0;
      scored.push({
        doc,
        at: doc.at,
        score: Number((coverage + recency).toFixed(4)),
        text: truncateText(doc.text, CHUNK_TEXT_LIMIT),
      });
    }

    scored.sort((a, b) => b.score - a.score || b.at - a.at);

    const seen = new Set<string>();
    const out: MemoryChunk[] = [];
    for (const item of scored) {
      const prefix = Array.from(item.text).slice(0, DEDUPE_PREFIX).join('');
      if (seen.has(prefix)) continue;
      seen.add(prefix);
      out.push({
        id: item.doc.id,
        text: item.text,
        at: item.at,
        who: item.doc.who,
        score: item.score,
      });
      if (out.length >= opts.limit) break;
    }
    return out;
  }

  stats(): { docs: number } {
    this.rebuildIfStale();
    return { docs: this.docs.length };
  }

  /** 当前会话内可进入模型的文档快照；过滤规则与本检索器完全一致。 */
  docsForSession(sessionKey: string): LexicalDoc[] {
    this.rebuildIfStale();
    return this.docs.filter((doc) => doc.sessionKey === sessionKey);
  }

  /** 索引是否过期：分片文件的 mtime/size 组合签名变化即过期。 */
  private rebuildIfStale(): void {
    const months = this.store.listMonths();
    const signature = months
      .map((month) => {
        const path = join(this.store.dir, `${month}.jsonl`);
        try {
          const stat = statSync(path);
          return `${month}:${stat.mtimeMs}:${stat.size}`;
        } catch {
          return `${month}:?`;
        }
      })
      .join('|');

    if (signature === this.signature) return;
    this.signature = signature;
    this.build(months);
  }

  private build(months: string[]): void {
    this.docs = [];
    this.inverted = new Map<string, Set<number>>();

    for (const month of months) {
      for (const record of this.store.readMonth(month)) {
        if (record.role !== 'user' && record.role !== 'assistant') continue;
        if (!this.isEligible(record)) continue;
        const at = Date.parse(record.t);
        if (!Number.isFinite(at)) continue;
        this.addDoc(record, at);
      }
    }
  }

  /**
   * v1.2 检索隔离：非管理员群消息（modelEligible=false）不进检索；
   * 旧群 user 记录缺 modelEligible fail-closed；旧私聊只有 private:<ownerQQ> 可检索；
   * CLI 与 assistant 记录维持原行为。
   */
  private isEligible(record: RawRecord): boolean {
    if (record.role === 'assistant') return true;

    if (record.modelEligible === true) return true;
    if (record.modelEligible === false) return false;

    if (record.sessionKey.startsWith('group:')) return false;
    if (record.sessionKey.startsWith('private:')) {
      return this.ownerQQ > 0 && record.sessionKey === `private:${this.ownerQQ}`;
    }
    return true;
  }

  private addDoc(record: RawRecord, at: number): void {
    const doc: Doc = {
      id: record.id,
      text: record.text,
      at,
      // 模型读【回忆】块时的视角：「你」= 用户说过的话，「我」= 自己以前的回复。
      who: record.role === 'user' ? '你' : '我',
      sessionKey: record.sessionKey,
      grams: grams(record.text),
    };
    const index = this.docs.length;
    this.docs.push(doc);
    for (const gram of doc.grams) {
      let bucket = this.inverted.get(gram);
      if (!bucket) {
        bucket = new Set<number>();
        this.inverted.set(gram, bucket);
      }
      bucket.add(index);
    }
  }
}

export { formatInjection };
