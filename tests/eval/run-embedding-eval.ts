import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

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
const LIMIT = 5;
const DEDUPE_PREFIX = 80;
const QUERY_INSTRUCTION =
  'Instruct: Given a search query, retrieve relevant passages that answer the query\nQuery: ';

function queryInput(query: string): string {
  return `${QUERY_INSTRUCTION}${query}`;
}

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
    const body = await response.text();
    throw new Error(`/api/embed ${response.status}: ${body.slice(0, 500)}`);
  }
  const data = (await response.json()) as { embeddings: number[][] };
  if (!Array.isArray(data.embeddings) || data.embeddings.length !== inputs.length) {
    throw new Error('Ollama 返回的 embeddings 数量与输入不一致');
  }
  return data.embeddings;
}

function norm(vector: number[]): number {
  let sum = 0;
  for (const value of vector) sum += value * value;
  return Math.sqrt(sum) || 1;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index]! * b[index]!;
  }
  return dot / (norm(a) * norm(b));
}

function percentile(sorted: number[], percent: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((percent / 100) * sorted.length)));
  return sorted[rank - 1]!;
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

function runCase(
  testCase: EvalCase,
  queryEmbedding: number[],
  docs: Array<{ id: string; sessionKey: string; text: string; embedding: number[] }>,
): string[] {
  const candidates = docs.filter((doc) => doc.sessionKey === testCase.sessionKey);
  const scored = candidates
    .map((doc) => ({ id: doc.id, text: doc.text, similarity: cosine(queryEmbedding, doc.embedding) }))
    .sort((a, b) => b.similarity - a.similarity || a.id.localeCompare(b.id));

  const seenPrefixes = new Set<string>();
  const hits: string[] = [];
  for (const item of scored) {
    const prefix = Array.from(item.text).slice(0, DEDUPE_PREFIX).join('');
    if (seenPrefixes.has(prefix)) continue;
    seenPrefixes.add(prefix);
    hits.push(item.id);
    if (hits.length >= LIMIT) break;
  }
  return hits;
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
  const dataset = JSON.parse(readFileSync(join(here, datasetFile), 'utf8')) as EvalDataset;
  const ownerQQ = dataset.meta.ownerQQ;

  // 冷启动：模型尚未加载时的首请求耗时。
  const coldStartedAt = performance.now();
  const coldEmbedding = await embed([queryInput('冷启动探针')]);
  const coldStartMs = performance.now() - coldStartedAt;
  console.log(`coldStartMs=${coldStartMs.toFixed(1)}`);
  console.log(`embeddingDim=${coldEmbedding[0]?.length ?? 0}`);

  // 文档候选集：与 BigramRetriever.isEligible 一致的过滤，且只按 sessionKey 隔离。
  const docs = dataset.corpus
    .filter((record) => isEligible(record, ownerQQ))
    .map((record) => ({ id: record.id, sessionKey: record.sessionKey, text: record.text }));
  const docEmbeddings = await embed(docs.map((doc) => doc.text));
  const docIndex = docs.map((doc, index) => ({
    id: doc.id,
    sessionKey: doc.sessionKey,
    text: doc.text,
    embedding: docEmbeddings[index]!,
  }));
  const eligibleIds = new Set(docs.map((doc) => doc.id));
  const docsById = new Map(docIndex.map((doc) => [doc.id, doc]));

  let peakRss = process.memoryUsage().rss;
  let isolationLeakCount = 0;

  // 预热一轮，避免首轮把模型/缓存开销计入热查询延迟。
  for (const testCase of dataset.cases) {
    const queryEmbedding = (await embed([queryInput(testCase.query)]))[0]!;
    runCase(testCase, queryEmbedding, docIndex);
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }

  const allLatencies: number[] = [];
  let firstPassMetrics: Metrics | null = null;

  for (let pass = 0; pass < 3; pass += 1) {
    const metrics = createMetrics();
    for (const testCase of dataset.cases) {
      const startedAt = performance.now();
      const queryEmbedding = (await embed([queryInput(testCase.query)]))[0]!;
      const hitIds = runCase(testCase, queryEmbedding, docIndex);
      const elapsedMs = performance.now() - startedAt;
      allLatencies.push(elapsedMs);
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
      if (pass === 0) {
        for (const hitId of hitIds) {
          const doc = docsById.get(hitId);
          if (!doc || !eligibleIds.has(hitId) || doc.sessionKey !== testCase.sessionKey) {
            isolationLeakCount += 1;
          }
        }
      }
      recordMetrics(metrics, testCase, hitIds);
    }
    if (pass === 0) firstPassMetrics = metrics;
  }

  if (!firstPassMetrics) throw new Error('评测未产生结果');

  printMetrics('P3-1 embedding (qwen3-embedding:0.6b, Ollama) 指标（首轮）', firstPassMetrics);

  allLatencies.sort((a, b) => a - b);
  console.log('');
  console.log(`cases=${dataset.cases.length} corpus=${dataset.corpus.length} deidentified=${String(dataset.meta.deidentified)}`);
  console.log(`hotQueryP50Ms=${percentile(allLatencies, 50).toFixed(2)}`);
  console.log(`hotQueryP95Ms=${percentile(allLatencies, 95).toFixed(2)}`);
  console.log(`hotQuerySamples=${allLatencies.length}`);
  console.log(`nodePeakRssMB=${(peakRss / (1024 * 1024)).toFixed(1)}`);
  console.log(`isolationLeakCount=${isolationLeakCount}`);
}

await main();
