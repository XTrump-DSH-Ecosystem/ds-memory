import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { HybridRetriever } from '../../src/memory/retriever/hybrid.ts';
import { createRetriever } from '../../src/memory/retriever/index.ts';
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

const DAY_MS = 86_400_000;
const LIMIT = 5;

function percentile(values: number[], percent: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((percent / 100) * sorted.length)));
  return sorted[rank - 1]!;
}

async function main(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const datasetFile = process.argv[2] ?? 'holdout-cases.json';
  const dataset = JSON.parse(readFileSync(join(here, datasetFile), 'utf8')) as EvalDataset;
  const modelDir =
    process.env.P3_MODEL_DIR ??
    resolve(here, '..', '..', '..', '.models', 'bge-small-zh-v1.5-onnx');
  const dir = mkdtempSync(join(tmpdir(), 'xds-hybrid-prod-eval-'));

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

    const retriever = createRetriever({
      store,
      ownerQQ: dataset.meta.ownerQQ,
      now: () => dataset.meta.now,
      recall: {
        engine: 'embedding',
        embedding: {
          modelDir,
          dtype: 'q8',
          device: 'cpu',
          maxCandidates: 20,
          batchSize: 8,
        },
      },
      onInfo: (message) => console.log(message),
      onWarn: (message) => console.error(message),
    });
    if (!(retriever instanceof HybridRetriever)) throw new Error('未构造 HybridRetriever');

    const startedAt = performance.now();
    for (const testCase of dataset.cases) {
      await retriever.search(testCase.query, {
        sessionKey: testCase.sessionKey,
        limit: LIMIT,
      });
    }
    const warmupMs = performance.now() - startedAt;
    const status = retriever.status();
    if (status.degraded) throw new Error(`embedding 已回退 bigram：${status.reason}`);

    let totalRelevant = 0;
    let retrievedRelevant = 0;
    let negativeCount = 0;
    let negativeCorrect = 0;
    let positiveCount = 0;
    let reciprocalRankSum = 0;
    const latencies: number[] = [];
    const misses: string[] = [];

    for (const testCase of dataset.cases) {
      const caseStartedAt = performance.now();
      const hits = await retriever.search(testCase.query, {
        sessionKey: testCase.sessionKey,
        limit: LIMIT,
      });
      latencies.push(performance.now() - caseStartedAt);
      const hitIds = hits.map((hit) => hit.id);

      if (testCase.expected.length === 0) {
        negativeCount += 1;
        if (hitIds.length === 0) negativeCorrect += 1;
        else misses.push(`${testCase.id} 负例误召回 ${hitIds.join(',')}`);
        continue;
      }

      positiveCount += 1;
      totalRelevant += testCase.expected.length;
      let firstRank = 0;
      for (const [index, id] of hitIds.entries()) {
        if (!testCase.expected.includes(id)) continue;
        retrievedRelevant += 1;
        if (firstRank === 0) firstRank = index + 1;
      }
      if (firstRank > 0) reciprocalRankSum += 1 / firstRank;
      else misses.push(`${testCase.id} 未命中，期望 ${testCase.expected.join(',')}，实际 ${hitIds.join(',')}`);
    }

    console.log(`dataset=${datasetFile} cases=${dataset.cases.length} corpus=${dataset.corpus.length}`);
    console.log(`warmupMs=${warmupMs.toFixed(1)}`);
    console.log(`Recall@5=${(retrievedRelevant / totalRelevant).toFixed(4)} (${retrievedRelevant}/${totalRelevant})`);
    console.log(`MRR(positive)=${(reciprocalRankSum / positiveCount).toFixed(4)}`);
    console.log(`negativeAccuracy=${(negativeCorrect / negativeCount).toFixed(3)}`);
    console.log(`latencyP50Ms=${percentile(latencies, 50).toFixed(2)}`);
    console.log(`latencyP95Ms=${percentile(latencies, 95).toFixed(2)}`);
    if (misses.length > 0) {
      console.log('misses:');
      for (const miss of misses) console.log(`- ${miss}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

await main();
