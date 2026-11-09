import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { BigramRetriever } from '../../src/memory/retriever/bigram.ts';
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

const DAY_MS = 86_400_000;

interface CategoryStat {
  positive: number;
  relevant: number;
  retrieved: number;
  negative: number;
  negativeCorrect: number;
}

async function main(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const datasetFile = process.argv[2] ?? 'cases.json';
  const raw = readFileSync(join(here, datasetFile), 'utf8');
  const dataset = JSON.parse(raw) as EvalDataset;

  const dir = mkdtempSync(join(tmpdir(), 'xds-recall-eval-'));
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
      ownerQQ: dataset.meta.ownerQQ,
    });
    // 预热索引，避免首查的建索引耗时污染延迟口径。
    retriever.stats();

    let totalRelevant = 0;
    let retrievedRelevant = 0;
    let mrrSum = 0;
    let latencySumMs = 0;
    const categoryStats = new Map<string, CategoryStat>();

    for (const testCase of dataset.cases) {
      const startedAt = performance.now();
      const hits = await retriever.search(testCase.query, {
        sessionKey: testCase.sessionKey,
        limit: 5,
      });
      latencySumMs += performance.now() - startedAt;

      const hitIds = hits.map((hit) => hit.id);
      const expectedSet = new Set(testCase.expected);
      const isNegative = testCase.expected.length === 0;

      const stat =
        categoryStats.get(testCase.category) ??
        ({ positive: 0, relevant: 0, retrieved: 0, negative: 0, negativeCorrect: 0 } satisfies CategoryStat);

      if (isNegative) {
        stat.negative += 1;
        if (hits.length === 0) {
          stat.negativeCorrect += 1;
          mrrSum += 1;
        }
      } else {
        stat.positive += 1;
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
        totalRelevant += testCase.expected.length;
        retrievedRelevant += found;
        if (firstRank > 0) mrrSum += 1 / firstRank;
      }

      categoryStats.set(testCase.category, stat);
    }

    const caseCount = dataset.cases.length;
    const recallAt5 = totalRelevant === 0 ? 0 : retrievedRelevant / totalRelevant;
    const mrr = mrrSum / caseCount;
    const avgLatencyMs = latencySumMs / caseCount;

    console.log('=== P3-0 bigram 召回基线 ===');
    console.log(`cases=${caseCount} corpus=${dataset.corpus.length} deidentified=${String(dataset.meta.deidentified)}`);
    console.log(`Recall@5=${recallAt5.toFixed(4)} (${retrievedRelevant}/${totalRelevant})`);
    console.log(`MRR=${mrr.toFixed(4)}`);
    console.log(`avgLatencyMs=${avgLatencyMs.toFixed(3)}`);
    console.log('');
    console.log('按类别：');
    for (const [category, stat] of categoryStats) {
      const categoryRecall = stat.relevant === 0 ? 0 : stat.retrieved / stat.relevant;
      const negativeAccuracy =
        stat.negative === 0 ? null : stat.negativeCorrect / stat.negative;
      const negativeText =
        negativeAccuracy === null ? '' : ` | 负例命中=0 正确率 ${negativeAccuracy.toFixed(3)}`;
      console.log(
        `- ${category}: 正例 ${stat.positive} (Recall@5 ${categoryRecall.toFixed(4)})${negativeText}`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

await main();
