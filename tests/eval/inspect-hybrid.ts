import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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

interface Doc {
  id: string;
  sessionKey: string;
  text: string;
  embedding: number[];
}

const OLLAMA_URL = 'http://127.0.0.1:11434';
const MODEL = 'qwen3-embedding:0.6b';
const DAY_MS = 86_400_000;
const QUERY_INSTRUCTION =
  'Instruct: Given a search query, retrieve relevant passages that answer the query\nQuery: ';

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

function inputPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const arg = process.argv[2] ?? 'cases.json';
  return resolve(here, arg);
}

async function main(): Promise<void> {
  const dataset = JSON.parse(readFileSync(inputPath(), 'utf8')) as EvalDataset;
  const dir = mkdtempSync(join(tmpdir(), 'xds-hybrid-inspect-'));

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
    retriever.stats();

    const docs = dataset.corpus
      .filter((record) => isEligible(record, dataset.meta.ownerQQ))
      .map((record, index) => ({ record, index }));
    const embeddings = await embed(docs.map(({ record }) => record.text));
    const embedded: Doc[] = docs.map(({ record }, index) => ({
      id: record.id,
      sessionKey: record.sessionKey,
      text: record.text,
      embedding: embeddings[index]!,
    }));

    for (const testCase of dataset.cases) {
      const bigram = await retriever.search(testCase.query, {
        sessionKey: testCase.sessionKey,
        limit: 20,
      });
      const queryEmbedding = (await embed([`${QUERY_INSTRUCTION}${testCase.query}`]))[0]!;
      const semantic = embedded
        .filter((doc) => doc.sessionKey === testCase.sessionKey)
        .map((doc) => ({ id: doc.id, sim: Number(cosine(queryEmbedding, doc.embedding).toFixed(4)) }))
        .sort((a, b) => b.sim - a.sim || a.id.localeCompare(b.id));
      const similarities = semantic.map((doc) => doc.sim);
      const mean =
        similarities.length === 0
          ? 0
          : similarities.reduce((sum, value) => sum + value, 0) / similarities.length;
      const variance =
        similarities.length === 0
          ? 0
          : similarities.reduce((sum, value) => sum + (value - mean) ** 2, 0) / similarities.length;
      const std = Math.sqrt(variance);

      console.log(JSON.stringify({
        id: testCase.id,
        category: testCase.category,
        query: testCase.query,
        expected: testCase.expected,
        bigram: bigram.map((hit) => ({ id: hit.id, score: hit.score })),
        semantic: semantic.slice(0, 6),
        semanticStats: {
          count: semantic.length,
          mean: Number(mean.toFixed(4)),
          std: Number(std.toFixed(4)),
          zTop1: Number((std > 0 ? (similarities[0]! - mean) / std : 0).toFixed(3)),
          gap12: Number(((similarities[0] ?? 0) - (similarities[1] ?? 0)).toFixed(4)),
        },
      }));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

await main();
