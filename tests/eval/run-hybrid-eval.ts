import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { BigramRetriever, grams } from '../../src/memory/retriever/bigram.ts';
import { EventStore } from '../../src/memory/store.ts';

interface CorpusRecord {
  id: string;
  sessionKey: string;
  role: 'user' | 'assistant';
  text: string;
  tOffsetDays: number;
  modelEligible?: boolean;
  senderQqId?: string;
}

interface EvalCase {
  id: string;
  category: string;
  sessionKey: string;
  query: string;
  expected: string[];
  note: string;
}

interface EvalDataset {
  meta: {
    description: string;
    deidentified: boolean;
    ownerQQ: number;
    now: number;
  };
  corpus: CorpusRecord[];
  cases: EvalCase[];
}

interface AliasGroup {
  id: string;
  terms: string[];
}

interface AliasFile {
  meta: { description: string; version: number };
  groups: AliasGroup[];
}

interface Doc {
  id: string;
  sessionKey: string;
  text: string;
  at: number;
  embedding: number[];
}

interface AnchorSlot {
  key: string;
  terms: string[];
}

interface GateResult {
  accepted: boolean;
  reason: string;
  hardMatchedIds: Set<string>;
}

interface CategoryStat {
  positive: number;
  relevant: number;
  retrieved: number;
  negative: number;
  negativeCorrect: number;
}

interface Metrics {
  totalRelevant: number;
  retrievedRelevant: number;
  caseCount: number;
  positiveCount: number;
  negativeCount: number;
  negativeCorrect: number;
  positiveMrrSum: number;
  allMrrSum: number;
  categoryStats: Map<string, CategoryStat>;
}

const OLLAMA_URL = 'http://127.0.0.1:11434';
const MODEL = 'qwen3-embedding:0.6b';
const DAY_MS = 86_400_000;
const LIMIT = 5;
const CANDIDATE_LIMIT = 20;
const DEDUPE_PREFIX = 80;
const LEXICAL_WEIGHT = 0.25;
const SEMANTIC_WEIGHT = 0.75;
const QUERY_INSTRUCTION =
  'Instruct: Given a search query, retrieve relevant passages that answer the query\nQuery: ';

const WEAK_CHARS = new Set(
  Array.from('我你他她它的了是在有和与就都也还又很太不没这那哪什么吗呢吧啊呀哦嗯个些么着过把被给对从到里上下来去说会能要想请帮'),
);

function isEligible(record: CorpusRecord, ownerQQ: number): boolean {
  if (record.role === 'assistant') return true;
  if (record.modelEligible === true) return true;
  if (record.modelEligible === false) return false;
  if (record.sessionKey.startsWith('group:')) return false;
  if (record.sessionKey.startsWith('private:')) {
    return ownerQQ > 0 && record.sessionKey === `private:${ownerQQ}`;
  }
  return true;
}

async function embed(inputs: string[]): Promise<number[][]> {
  const response = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, input: inputs }),
  });
  if (!response.ok) {
    throw new Error(`/api/embed ${response.status}: ${(await response.text()).slice(0, 500)}`);
  }
  const body = (await response.json()) as { embeddings: number[][] };
  if (!Array.isArray(body.embeddings) || body.embeddings.length !== inputs.length) {
    throw new Error('Ollama 返回的 embeddings 数量与输入不一致');
  }
  return body.embeddings;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index]! * b[index]!;
    aa += a[index]! * a[index]!;
    bb += b[index]! * b[index]!;
  }
  return dot / (Math.sqrt(aa) * Math.sqrt(bb) || 1);
}

function percentile(sorted: number[], percent: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((percent / 100) * sorted.length)));
  return sorted[rank - 1]!;
}

function isWeakAnchor(term: string): boolean {
  if (/^[a-z0-9]+$/i.test(term)) return term.length < 2;
  if (Array.from(term).length <= 1) return true;
  return Array.from(term).every((char) => WEAK_CHARS.has(char));
}

function termMatches(term: string, text: string): boolean {
  if (/^[a-z0-9]+$/i.test(term)) return grams(text).has(term.toLowerCase());
  return text.includes(term);
}

function buildAnchorSlots(query: string, aliases: AliasGroup[]): AnchorSlot[] {
  const normalized = query.toLowerCase();
  const slots: AnchorSlot[] = [];
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

function hardAnchors(query: string): string[] {
  return [...grams(query)].filter((term) => /^[a-z0-9]+$/i.test(term) && term.length >= 2);
}

function evaluateGate(
  query: string,
  sessionDocs: Doc[],
  aliases: AliasGroup[],
): GateResult {
  if (sessionDocs.length === 0) {
    return { accepted: false, reason: 'no-eligible-doc', hardMatchedIds: new Set() };
  }

  const hardTerms = hardAnchors(query);
  const hardMatchedIds = new Set<string>();
  for (const doc of sessionDocs) {
    if (hardTerms.some((term) => termMatches(term, doc.text))) hardMatchedIds.add(doc.id);
  }
  if (hardMatchedIds.size > 0) {
    return { accepted: true, reason: 'hard-anchor', hardMatchedIds };
  }

  const slots = buildAnchorSlots(query, aliases);
  const coverage = new Map<string, number>();
  let matchedSlots = 0;
  for (const slot of slots) {
    let slotMatched = false;
    for (const doc of sessionDocs) {
      if (slot.terms.some((term) => termMatches(term, doc.text))) {
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

function dedupeByIdAndPrefix(
  items: Array<{ id: string; text: string; score: number; at: number }>,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const prefix = Array.from(item.text).slice(0, DEDUPE_PREFIX).join('');
    if (seen.has(prefix)) continue;
    seen.add(prefix);
    out.push(item.id);
    if (out.length >= LIMIT) break;
  }
  return out;
}

function createMetrics(): Metrics {
  return {
    totalRelevant: 0,
    retrievedRelevant: 0,
    caseCount: 0,
    positiveCount: 0,
    negativeCount: 0,
    negativeCorrect: 0,
    positiveMrrSum: 0,
    allMrrSum: 0,
    categoryStats: new Map(),
  };
}

function recordMetrics(metrics: Metrics, testCase: EvalCase, hitIds: string[]): void {
  metrics.caseCount += 1;
  const expectedSet = new Set(testCase.expected);
  const isNegative = testCase.expected.length === 0;

  const stat =
    metrics.categoryStats.get(testCase.category) ??
    ({ positive: 0, relevant: 0, retrieved: 0, negative: 0, negativeCorrect: 0 } satisfies CategoryStat);

  if (isNegative) {
    stat.negative += 1;
    metrics.negativeCount += 1;
    if (hitIds.length === 0) {
      stat.negativeCorrect += 1;
      metrics.negativeCorrect += 1;
      metrics.allMrrSum += 1;
    }
  } else {
    stat.positive += 1;
    metrics.positiveCount += 1;
    stat.relevant += testCase.expected.length;
    let found = 0;
    let firstRank = 0;
    for (const [index, hitId] of hitIds.entries()) {
      if (expectedSet.has(hitId)) {
        found += 1;
        if (firstRank === 0) firstRank = index + 1;
      }
    }
    stat.retrieved += found;
    metrics.totalRelevant += testCase.expected.length;
    metrics.retrievedRelevant += found;
    if (firstRank > 0) {
      const reciprocalRank = 1 / firstRank;
      metrics.positiveMrrSum += reciprocalRank;
      metrics.allMrrSum += reciprocalRank;
    }
  }

  metrics.categoryStats.set(testCase.category, stat);
}

function printMetrics(label: string, metrics: Metrics): void {
  const recallAt5 =
    metrics.totalRelevant === 0 ? 0 : metrics.retrievedRelevant / metrics.totalRelevant;
  const allMrr = metrics.caseCount === 0 ? 0 : metrics.allMrrSum / metrics.caseCount;
  const positiveMrr =
    metrics.positiveCount === 0 ? 0 : metrics.positiveMrrSum / metrics.positiveCount;
  const negativeAccuracy =
    metrics.negativeCount === 0 ? 1 : metrics.negativeCorrect / metrics.negativeCount;
  console.log(`=== ${label} ===`);
  console.log(`Recall@5=${recallAt5.toFixed(4)} (${metrics.retrievedRelevant}/${metrics.totalRelevant})`);
  console.log(`MRR(all-case)=${allMrr.toFixed(4)}`);
  console.log(`MRR(positive-only)=${positiveMrr.toFixed(4)}`);
  console.log(`negativeAccuracy=${negativeAccuracy.toFixed(3)}`);
  console.log('按类别：');
  for (const [category, stat] of metrics.categoryStats) {
    const categoryRecall = stat.relevant === 0 ? 0 : stat.retrieved / stat.relevant;
    const negativeAccuracy =
      stat.negative === 0 ? null : stat.negativeCorrect / stat.negative;
    const negativeText =
      negativeAccuracy === null ? '' : ` | 负例正确率 ${negativeAccuracy.toFixed(3)}`;
    console.log(
      `- ${category}: 正例 ${stat.positive} (Recall@5 ${categoryRecall.toFixed(4)})${negativeText}`,
    );
  }
}

async function main(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const datasetFile = process.argv[2] ?? 'cases.json';
  const verbose = process.argv.includes('--verbose');
  const dataset = JSON.parse(readFileSync(join(here, datasetFile), 'utf8')) as EvalDataset;
  const aliases = (
    JSON.parse(readFileSync(join(here, 'hybrid-aliases.json'), 'utf8')) as AliasFile
  ).groups;
  const ownerQQ = dataset.meta.ownerQQ;

  const coldStartedAt = performance.now();
  const coldEmbedding = await embed([`${QUERY_INSTRUCTION}冷启动探针`]);
  const coldStartMs = performance.now() - coldStartedAt;
  console.log(`coldStartMs=${coldStartMs.toFixed(1)}`);
  console.log(`embeddingDim=${coldEmbedding[0]?.length ?? 0}`);

  const dir = mkdtempSync(join(tmpdir(), 'xds-hybrid-eval-'));
  try {
    const store = new EventStore({ dir, now: () => dataset.meta.now });
    for (const record of dataset.corpus) {
      store.append({
        id: record.id,
        src: record.sessionKey.startsWith('cli:') ? 'cli' : 'qq',
        sessionKey: record.sessionKey,
        role: record.role,
        text: record.text,
        speaker: null,
        quote: null,
        isAtBot: false,
        ...(record.modelEligible !== undefined ? { modelEligible: record.modelEligible } : {}),
        ...(record.senderQqId !== undefined ? { senderQqId: record.senderQqId } : {}),
        t: dataset.meta.now + record.tOffsetDays * DAY_MS,
      });
    }

    const retriever = new BigramRetriever({
      store,
      now: () => dataset.meta.now,
      ownerQQ,
    });
    retriever.stats();

    const docs = dataset.corpus
      .filter((record) => isEligible(record, ownerQQ))
      .map((record) => ({
        id: record.id,
        sessionKey: record.sessionKey,
        text: record.text,
        at: dataset.meta.now + record.tOffsetDays * DAY_MS,
      }));
    const docEmbeddings = await embed(docs.map((doc) => doc.text));
    const embeddedDocs: Doc[] = docs.map((doc, index) => ({
      ...doc,
      embedding: docEmbeddings[index]!,
    }));
    const eligibleIds = new Set(embeddedDocs.map((doc) => doc.id));
    const docsById = new Map(embeddedDocs.map((doc) => [doc.id, doc]));

    let peakRss = process.memoryUsage().rss;
    let isolationLeakCount = 0;
    const gateReasons = new Map<string, number>();

    const runCase = async (testCase: EvalCase): Promise<string[]> => {
      const queryEmbedding = (await embed([`${QUERY_INSTRUCTION}${testCase.query}`]))[0]!;
      const sessionDocs = embeddedDocs.filter((doc) => doc.sessionKey === testCase.sessionKey);
      const gate = evaluateGate(testCase.query, sessionDocs, aliases);
      gateReasons.set(gate.reason, (gateReasons.get(gate.reason) ?? 0) + 1);
      if (!gate.accepted) {
        if (verbose) console.log(`ABSTAIN ${testCase.id} reason=${gate.reason}`);
        return [];
      }

      const lexical = await retriever.search(testCase.query, {
        sessionKey: testCase.sessionKey,
        limit: CANDIDATE_LIMIT,
      });
      const lexicalById = new Map(lexical.map((hit) => [hit.id, hit.score]));

      const semantic = sessionDocs
        .map((doc) => ({
          id: doc.id,
          similarity: cosine(queryEmbedding, doc.embedding),
        }))
        .sort((a, b) => b.similarity - a.similarity || a.id.localeCompare(b.id))
        .slice(0, CANDIDATE_LIMIT);

      const candidateIds = new Set<string>([
        ...lexical.map((hit) => hit.id),
        ...semantic.map((item) => item.id),
      ]);
      if (candidateIds.size === 0) return [];

      const semanticById = new Map(semantic.map((item) => [item.id, item.similarity]));
      const semanticValues = [...semanticById.values()];
      const semanticMin = Math.min(...semanticValues);
      const semanticMax = Math.max(...semanticValues);
      const maxLexical = Math.max(0, ...lexicalById.values());

      const scored = [...candidateIds]
        .map((id) => {
          const doc = docsById.get(id);
          if (!doc) return null;
          const lexicalScore = lexicalById.get(id) ?? 0;
          const lexicalNorm = maxLexical > 0 ? lexicalScore / maxLexical : 0;
          const similarity = semanticById.get(id) ?? 0;
          const semanticNorm =
            semanticMax > semanticMin ? (similarity - semanticMin) / (semanticMax - semanticMin) : 1;
          const hardBoost = gate.hardMatchedIds.has(id) ? 1 : 0;
          const score =
            LEXICAL_WEIGHT * lexicalNorm +
            SEMANTIC_WEIGHT * semanticNorm +
            hardBoost;
          return { id, text: doc.text, at: doc.at, score };
        })
        .filter((item): item is { id: string; text: string; at: number; score: number } => item !== null)
        .sort((a, b) => b.score - a.score || b.at - a.at || a.id.localeCompare(b.id));

      const hitIds = dedupeByIdAndPrefix(scored);
      for (const id of hitIds) {
        if (!eligibleIds.has(id)) isolationLeakCount += 1;
      }

      if (verbose) {
        const expected = new Set(testCase.expected);
        const missed = testCase.expected.filter((id) => !hitIds.includes(id));
        if (testCase.expected.length > 0 && missed.length > 0) {
          console.log(
            `MISS ${testCase.id} expected=${testCase.expected.join(',')} got=${hitIds.join(',')} gate=${gate.reason}`,
          );
        } else if (testCase.expected.length > 0 && !expected.has(hitIds[0] ?? '')) {
          console.log(
            `RANK ${testCase.id} expected=${testCase.expected.join(',')} got=${hitIds.join(',')} gate=${gate.reason}`,
          );
        }
      }
      return hitIds;
    };

    // 预热一轮，避免模型/缓存冷启动污染热查询延迟。
    for (const testCase of dataset.cases) {
      await runCase(testCase);
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
    }

    const allLatencies: number[] = [];
    let firstPassMetrics: Metrics | null = null;

    for (let pass = 0; pass < 3; pass += 1) {
      const metrics = createMetrics();
      for (const testCase of dataset.cases) {
        const startedAt = performance.now();
        const hitIds = await runCase(testCase);
        allLatencies.push(performance.now() - startedAt);
        recordMetrics(metrics, testCase, hitIds);
        peakRss = Math.max(peakRss, process.memoryUsage().rss);
      }
      if (pass === 0) firstPassMetrics = metrics;
    }

    if (!firstPassMetrics) throw new Error('首轮指标缺失');
    printMetrics('P3-2 hybrid (bigram + qwen3-embedding + 证据门) 指标（首轮）', firstPassMetrics);

    const hotLatencies = allLatencies.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
    const gateSummary = [...gateReasons.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([reason, count]) => `${reason}:${count}`)
      .join(', ');

    console.log('');
    console.log(`cases=${dataset.cases.length} corpus=${dataset.corpus.length} deidentified=${String(dataset.meta.deidentified)}`);
    console.log(`hotQueryP50Ms=${percentile(hotLatencies, 50).toFixed(2)}`);
    console.log(`hotQueryP95Ms=${percentile(hotLatencies, 95).toFixed(2)}`);
    console.log(`hotQuerySamples=${hotLatencies.length}`);
    console.log(`nodePeakRssMB=${(peakRss / 1024 / 1024).toFixed(1)}`);
    console.log(`isolationLeakCount=${isolationLeakCount}`);
    console.log(`gateReasons=${gateSummary}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

await main();
