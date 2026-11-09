import { truncateText } from '../../util/string.ts';
import { PRODUCTION_ALIASES } from './aliases.ts';
import {
  BigramRetriever,
  CHUNK_TEXT_LIMIT,
  grams,
  type LexicalDoc,
} from './bigram.ts';
import type { MemoryChunk, Retriever, SearchOptions } from './types.ts';
import type { Embedder } from './embedding.ts';

const LEXICAL_WEIGHT = 0.25;
const SEMANTIC_WEIGHT = 0.75;
const DEDUPE_PREFIX = 80;

const WEAK_CHARS = new Set(
  Array.from(
    '我你他她它的了是在有和与就都也还又很太不没这那哪什么吗呢吧啊呀哦嗯个些么着过把被给对从到里上下来去说会能要想请帮一次多久怎为几时候谁可以什',
  ),
);

/**
 * 常见疑问/时间/指代短语不承担“记忆证据”职责。
 * 例如「一次」可能同时出现在多条无关记录中，不能据此判定 split-evidence。
 */
const STOP_TERMS = new Set([
  '一次',
  '多久',
  '什么',
  '怎么',
  '怎么样',
  '为什么',
  '哪个',
  '哪些',
  '哪里',
  '哪儿',
  '这个',
  '那个',
  '这些',
  '那些',
  '我们',
  '你们',
  '他们',
  '可以',
  '能否',
  '是否',
  '是不是',
  '有没有',
  '没有',
  '还是',
  '就是',
  '然后',
  '现在',
  '刚才',
  '之前',
  '以前',
  '上次',
  '下次',
  '时候',
  '东西',
  '事情',
  '问题',
  '地方',
  '样子',
]);

export interface AliasGroup {
  id: string;
  terms: string[];
}

export interface EvidenceDoc {
  id: string;
  text: string;
  grams?: ReadonlySet<string>;
}

export interface EvidenceGateResult {
  accepted: boolean;
  reason:
    | 'no-eligible-doc'
    | 'hard-anchor'
    | 'no-lexical-evidence'
    | 'split-evidence'
    | 'lexical-evidence';
  hardMatchedIds: Set<string>;
}

function docGrams(doc: EvidenceDoc): ReadonlySet<string> {
  return doc.grams ?? grams(doc.text);
}

function isWeakAnchor(term: string): boolean {
  if (STOP_TERMS.has(term)) return true;
  if (/^[a-z0-9]+$/i.test(term)) return term.length < 2;
  if (Array.from(term).length <= 1) return WEAK_CHARS.has(term);
  return Array.from(term).every((char) => WEAK_CHARS.has(char));
}

function termMatches(term: string, doc: EvidenceDoc): boolean {
  if (/^[a-z0-9]+$/i.test(term)) return docGrams(doc).has(term.toLowerCase());
  return doc.text.includes(term);
}

function buildAnchorSlots(query: string, aliases: readonly AliasGroup[]) {
  const normalized = query.toLowerCase();
  const slots: Array<{ key: string; terms: string[] }> = [];
  const seen = new Set<string>();

  for (const group of aliases) {
    if (!group.terms.some((term) => normalized.includes(term.toLowerCase()))) continue;
    const key = `alias:${group.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    slots.push({ key, terms: group.terms });
  }

  for (const term of grams(query)) {
    if (isWeakAnchor(term)) continue;
    const key = `term:${term}`;
    if (seen.has(key)) continue;
    seen.add(key);
    slots.push({ key, terms: [term] });
  }
  return slots;
}

/**
 * 词法证据门：embedding 只负责候选与排序，不能单独决定「有记忆」。
 *
 * - 数字/英文标识符精确命中：直接放行
 * - 没有任何中文 bigram/别名证据：弃权
 * - 多个证据槽分散在不同记录、没有单条同时覆盖两个槽：split-evidence 弃权
 */
export function evaluateEvidenceGate(
  query: string,
  docs: readonly EvidenceDoc[],
  aliases: readonly AliasGroup[] = [],
): EvidenceGateResult {
  if (docs.length === 0) {
    return { accepted: false, reason: 'no-eligible-doc', hardMatchedIds: new Set() };
  }

  const hardTerms = [...grams(query)].filter(
    (term) => /^[a-z0-9]+$/i.test(term) && term.length >= 2,
  );
  const hardMatchedIds = new Set<string>();
  for (const doc of docs) {
    if (hardTerms.some((term) => termMatches(term, doc))) hardMatchedIds.add(doc.id);
  }
  if (hardMatchedIds.size > 0) {
    return { accepted: true, reason: 'hard-anchor', hardMatchedIds };
  }

  const slots = buildAnchorSlots(query, aliases);
  const coverage = new Map<string, number>();
  let matchedSlots = 0;

  for (const slot of slots) {
    let slotMatched = false;
    for (const doc of docs) {
      if (slot.terms.some((term) => termMatches(term, doc))) {
        slotMatched = true;
        coverage.set(doc.id, (coverage.get(doc.id) ?? 0) + 1);
      }
    }
    if (slotMatched) matchedSlots += 1;
  }

  if (matchedSlots === 0) {
    return { accepted: false, reason: 'no-lexical-evidence', hardMatchedIds };
  }

  const maxCoverage = Math.max(0, ...coverage.values());
  if (matchedSlots >= 2 && maxCoverage < 2) {
    return { accepted: false, reason: 'split-evidence', hardMatchedIds };
  }
  return { accepted: true, reason: 'lexical-evidence', hardMatchedIds };
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let aa = 0;
  let bb = 0;
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    dot += a[index]! * b[index]!;
    aa += a[index]! * a[index]!;
    bb += b[index]! * b[index]!;
  }
  return dot / (Math.sqrt(aa) * Math.sqrt(bb) || 1);
}

interface ScoredDoc {
  id: string;
  text: string;
  at: number;
  who: string;
  score: number;
}

function fuseAndSelect(
  lexical: readonly MemoryChunk[],
  docs: readonly LexicalDoc[],
  vectors: ReadonlyMap<string, number[]>,
  queryVector: readonly number[],
  gate: EvidenceGateResult,
  maxCandidates: number,
  limit: number,
): MemoryChunk[] {
  const docsById = new Map(docs.map((doc) => [doc.id, doc]));
  const lexicalById = new Map(lexical.map((hit) => [hit.id, hit.score]));

  const semantic = docs
    .map((doc) => ({
      id: doc.id,
      similarity: cosine(queryVector, vectors.get(doc.text) ?? []),
    }))
    .sort((a, b) => b.similarity - a.similarity || a.id.localeCompare(b.id))
    .slice(0, maxCandidates);
  const semanticById = new Map(semantic.map((item) => [item.id, item.similarity]));

  const candidateIds = new Set<string>([
    ...lexical.map((hit) => hit.id),
    ...semantic.map((item) => item.id),
    ...gate.hardMatchedIds,
  ]);
  if (candidateIds.size === 0) return [];

  const semanticValues = [...semanticById.values()];
  const semanticMin = semanticValues.length > 0 ? Math.min(...semanticValues) : 0;
  const semanticMax = semanticValues.length > 0 ? Math.max(...semanticValues) : 0;
  const maxLexical = Math.max(0, ...lexicalById.values());

  const scored: ScoredDoc[] = [];
  for (const id of candidateIds) {
    const doc = docsById.get(id);
    if (!doc) continue;
    const lexicalScore = lexicalById.get(id) ?? 0;
    const lexicalNorm = maxLexical > 0 ? lexicalScore / maxLexical : 0;
    const similarity = semanticById.get(id) ?? 0;
    const semanticNorm =
      semanticMax > semanticMin
        ? (similarity - semanticMin) / (semanticMax - semanticMin)
        : semanticById.has(id)
          ? 1
          : 0;
    const hardBoost = gate.hardMatchedIds.has(id) ? 1 : 0;
    const score =
      LEXICAL_WEIGHT * lexicalNorm + SEMANTIC_WEIGHT * semanticNorm + hardBoost;
    scored.push({
      id,
      text: truncateText(doc.text, CHUNK_TEXT_LIMIT),
      at: doc.at,
      who: doc.who,
      score: Number(score.toFixed(4)),
    });
  }

  scored.sort((a, b) => b.score - a.score || b.at - a.at || a.id.localeCompare(b.id));

  const seen = new Set<string>();
  const out: MemoryChunk[] = [];
  for (const item of scored) {
    const prefix = Array.from(item.text).slice(0, DEDUPE_PREFIX).join('');
    if (seen.has(prefix)) continue;
    seen.add(prefix);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

export interface HybridRetrieverOptions {
  store: ConstructorParameters<typeof BigramRetriever>[0]['store'];
  ownerQQ?: number;
  now?: () => number;
  embedder: Embedder;
  aliases?: readonly AliasGroup[];
  maxCandidates?: number;
  onWarn?: (message: string) => void;
}

/**
 * bigram 词法证据门 + BGE 语义候选的生产检索器。
 *
 * 失败策略：模型缺失、哈希不符、native 加载或推理异常时，只告警一次，
 * 本进程永久回退到 BigramRetriever；不会阻断聊天、L0 或 !回忆。
 */
export class HybridRetriever implements Retriever {
  readonly id = 'embedding' as const;

  private readonly bigram: BigramRetriever;
  private readonly embedder: Embedder;
  private readonly aliases: readonly AliasGroup[];
  private readonly maxCandidates: number;
  private readonly onWarn?: (message: string) => void;
  private readonly vectors = new Map<string, number[]>();

  private degraded = false;
  private degradeReason = '';

  constructor(options: HybridRetrieverOptions) {
    this.bigram = new BigramRetriever({
      store: options.store,
      ...(options.ownerQQ !== undefined ? { ownerQQ: options.ownerQQ } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
    });
    this.embedder = options.embedder;
    this.aliases = options.aliases ?? PRODUCTION_ALIASES;
    this.maxCandidates = options.maxCandidates ?? 20;
    this.onWarn = options.onWarn;
  }

  async search(query: string, opts: SearchOptions): Promise<MemoryChunk[]> {
    const trimmed = query.trim();
    if (trimmed.length === 0) return [];

    const lexical = await this.bigram.search(trimmed, {
      sessionKey: opts.sessionKey,
      limit: this.maxCandidates,
    });
    if (this.degraded) return lexical.slice(0, opts.limit);

    try {
      const docs = this.bigram.docsForSession(opts.sessionKey);
      const gate = evaluateEvidenceGate(trimmed, docs, this.aliases);
      if (!gate.accepted) return [];

      const queryVector = (await this.embedder.embed([trimmed], 'query'))[0];
      if (!queryVector || queryVector.length === 0) {
        throw new Error('embedding 返回空向量');
      }
      await this.ensureDocVectors(docs);

      return fuseAndSelect(
        lexical,
        docs,
        this.vectors,
        queryVector,
        gate,
        this.maxCandidates,
        opts.limit,
      );
    } catch (err) {
      this.degrade(err);
      return lexical.slice(0, opts.limit);
    }
  }

  stats(): { docs: number } {
    return this.bigram.stats();
  }

  status(): { engine: 'embedding' | 'bigram'; degraded: boolean; reason: string } {
    return {
      engine: this.degraded ? 'bigram' : 'embedding',
      degraded: this.degraded,
      reason: this.degradeReason,
    };
  }

  private async ensureDocVectors(docs: readonly LexicalDoc[]): Promise<void> {
    const missing: string[] = [];
    const seen = new Set<string>();
    for (const doc of docs) {
      if (this.vectors.has(doc.text) || seen.has(doc.text)) continue;
      seen.add(doc.text);
      missing.push(doc.text);
    }
    if (missing.length === 0) return;

    const embeddings = await this.embedder.embed(missing, 'document');
    if (embeddings.length !== missing.length) {
      throw new Error(
        `embedding 文档数量异常：期望 ${missing.length}，实际 ${embeddings.length}`,
      );
    }
    for (const [index, text] of missing.entries()) {
      const vector = embeddings[index];
      if (!vector || vector.length === 0) throw new Error('embedding 返回空文档向量');
      this.vectors.set(text, vector);
    }
  }

  private degrade(err: unknown): void {
    if (this.degraded) return;
    this.degraded = true;
    this.degradeReason = err instanceof Error ? err.message : String(err);
    this.onWarn?.(`embedding 检索不可用，已永久回退 bigram：${this.degradeReason}`);
  }
}
