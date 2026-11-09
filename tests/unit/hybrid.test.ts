import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PRODUCTION_ALIASES } from '../../src/memory/retriever/aliases.ts';
import { BgeSmallZhEmbedder, type EmbedKind, type Embedder } from '../../src/memory/retriever/embedding.ts';
import {
  BGE_MODEL_FILES,
  verifyModelFiles,
  type ModelFileSpec,
} from '../../src/memory/retriever/embedding-model.ts';
import {
  HybridRetriever,
  evaluateEvidenceGate,
} from '../../src/memory/retriever/hybrid.ts';
import { createRetriever } from '../../src/memory/retriever/index.ts';
import { EventStore } from '../../src/memory/store.ts';

let dir: string;
let clock: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'xds-hybrid-'));
  clock = 1_700_000_000_000;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeStore(): EventStore {
  return new EventStore({ dir, now: () => clock });
}

class FakeEmbedder implements Embedder {
  readonly id = 'fake';
  readonly calls: Array<{ texts: string[]; kind: EmbedKind }> = [];
  private readonly vectors: Map<string, number[]>;
  private readonly fail: boolean;

  constructor(vectors: Map<string, number[]>, fail = false) {
    this.vectors = vectors;
    this.fail = fail;
  }

  async embed(texts: readonly string[], kind: EmbedKind): Promise<number[][]> {
    this.calls.push({ texts: [...texts], kind });
    if (this.fail) throw new Error('fake inference failure');
    return texts.map((text) => this.vectors.get(text) ?? [0, 1]);
  }
}

function hybrid(
  store: EventStore,
  embedder: Embedder,
  options: { ownerQQ?: number; maxCandidates?: number; onWarn?: (message: string) => void } = {},
): HybridRetriever {
  return new HybridRetriever({
    store,
    embedder,
    now: () => clock,
    ...options,
  });
}

describe('evaluateEvidenceGate', () => {
  it('数字/英文硬锚点命中直接放行', () => {
    const gate = evaluateEvidenceGate('4090 怎么样', [
      { id: 'a', text: '后来买了 RTX 4090' },
    ]);

    expect(gate.accepted).toBe(true);
    expect(gate.reason).toBe('hard-anchor');
    expect([...gate.hardMatchedIds]).toEqual(['a']);
  });

  it('没有任何词法证据时弃权', () => {
    const gate = evaluateEvidenceGate('还记得那个东西吗', [
      { id: 'a', text: '今天下了很大的雨' },
    ]);

    expect(gate).toMatchObject({
      accepted: false,
      reason: 'no-lexical-evidence',
    });
  });

  it('证据分散在不同记录时 split-evidence 弃权', () => {
    const gate = evaluateEvidenceGate('显卡价格', [
      { id: 'a', text: '显卡到了' },
      { id: 'b', text: '价格有点贵' },
    ]);

    expect(gate).toMatchObject({
      accepted: false,
      reason: 'split-evidence',
    });
  });

  it('疑问/时间弱锚点不制造假 split-evidence', () => {
    const gate = evaluateEvidenceGate('车多久保养一次？', [
      { id: 'a', text: '车是混动凯美瑞，保养间隔一万公里' },
      { id: 'b', text: '阳台的绿萝每周浇一次水' },
    ]);

    expect(gate).toMatchObject({
      accepted: true,
      reason: 'lexical-evidence',
    });
  });

  it('生产别名让术语改写通过证据门', () => {
    const gate = evaluateEvidenceGate(
      'GPU 是哪一款',
      [{ id: 'a', text: '我上个月买了一张 4090 显卡' }],
      PRODUCTION_ALIASES,
    );

    expect(gate).toMatchObject({
      accepted: true,
      reason: 'lexical-evidence',
    });
  });

  it('单个实词（如「猫」）可作为证据，单个虚词仍弃权', () => {
    expect(
      evaluateEvidenceGate('猫', [{ id: 'a', text: '家里养了一只橘猫叫咪咪' }]),
    ).toMatchObject({ accepted: true, reason: 'lexical-evidence' });
    expect(
      evaluateEvidenceGate('的', [{ id: 'a', text: '家里养了一只橘猫叫咪咪' }]),
    ).toMatchObject({ accepted: false, reason: 'no-lexical-evidence' });
  });

  it('没有可检索文档时弃权', () => {
    expect(evaluateEvidenceGate('4090', [])).toMatchObject({
      accepted: false,
      reason: 'no-eligible-doc',
    });
  });
});

describe('HybridRetriever', () => {
  it('语义相似度参与排序，硬锚点仍保证命中', async () => {
    const store = makeStore();
    store.append({
      id: 'lexical',
      src: 'cli',
      sessionKey: 'cli:a',
      role: 'user',
      text: '4090 显卡',
      t: clock - 1_000,
    });
    store.append({
      id: 'semantic',
      src: 'cli',
      sessionKey: 'cli:a',
      role: 'user',
      text: '4090 也还行',
      t: clock - 2_000,
    });
    const embedder = new FakeEmbedder(
      new Map([
        ['之前那张 4090', [1, 0]],
        ['4090 显卡', [0, 1]],
        ['4090 也还行', [1, 0]],
      ]),
    );

    const hits = await hybrid(store, embedder).search('之前那张 4090', {
      sessionKey: 'cli:a',
      limit: 5,
    });

    expect(hits.map((hit) => hit.id)).toEqual(['semantic', 'lexical']);
    expect(embedder.calls.map((call) => call.kind)).toEqual(['query', 'document']);
  });

  it('证据门弃权时不调用 embedding', async () => {
    const store = makeStore();
    store.append({
      id: 'a',
      src: 'cli',
      sessionKey: 'cli:b',
      role: 'user',
      text: '今天下了很大的雨',
      t: clock,
    });
    const embedder = new FakeEmbedder(new Map());

    const hits = await hybrid(store, embedder).search('还记得那个东西吗', {
      sessionKey: 'cli:b',
      limit: 5,
    });

    expect(hits).toEqual([]);
    expect(embedder.calls).toEqual([]);
  });

  it('严格保持 session 隔离与 modelEligible 过滤', async () => {
    const store = makeStore();
    store.append({
      id: 'owner',
      src: 'qq',
      sessionKey: 'group:9',
      role: 'user',
      text: 'owner 的 4090',
      senderQqId: '123456789',
      modelEligible: true,
      t: clock - 1000,
    });
    store.append({
      id: 'member',
      src: 'qq',
      sessionKey: 'group:9',
      role: 'user',
      text: '群友的 4090',
      senderQqId: '222333444',
      modelEligible: false,
      t: clock,
    });
    store.append({
      id: 'other-session',
      src: 'qq',
      sessionKey: 'group:10',
      role: 'user',
      text: '另一个群的 4090',
      modelEligible: true,
      t: clock,
    });
    const embedder = new FakeEmbedder(
      new Map([
        ['4090', [1, 0]],
        ['owner 的 4090', [1, 0]],
        ['群友的 4090', [1, 0]],
        ['另一个群的 4090', [1, 0]],
      ]),
    );

    const hits = await hybrid(store, embedder, { ownerQQ: 123456789 }).search('4090', {
      sessionKey: 'group:9',
      limit: 5,
    });

    expect(hits.map((hit) => hit.id)).toEqual(['owner']);
    const embeddedTexts = embedder.calls
      .filter((call) => call.kind === 'document')
      .flatMap((call) => call.texts);
    expect(embeddedTexts).toEqual(['owner 的 4090']);
  });

  it('推理失败时告警一次并永久回退 bigram', async () => {
    const store = makeStore();
    store.append({
      id: 'a',
      src: 'cli',
      sessionKey: 'cli:c',
      role: 'user',
      text: '买了 4090',
      t: clock,
    });
    const warnings: string[] = [];
    const retriever = hybrid(store, new FakeEmbedder(new Map(), true), {
      onWarn: (message) => warnings.push(message),
    });

    const first = await retriever.search('4090', { sessionKey: 'cli:c', limit: 5 });
    const second = await retriever.search('4090', { sessionKey: 'cli:c', limit: 5 });

    expect(first.map((hit) => hit.id)).toEqual(['a']);
    expect(second.map((hit) => hit.id)).toEqual(['a']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('回退 bigram');
    expect(retriever.status()).toMatchObject({ engine: 'bigram', degraded: true });
  });

  it('模型目录缺失时不影响启动，首次检索回退 bigram', async () => {
    const store = makeStore();
    store.append({
      id: 'a',
      src: 'cli',
      sessionKey: 'cli:d',
      role: 'user',
      text: '买了 4090',
      t: clock,
    });
    const warnings: string[] = [];
    const retriever = createRetriever({
      store,
      now: () => clock,
      recall: {
        engine: 'embedding',
        embedding: {
          modelDir: join(dir, 'missing-model'),
          dtype: 'q8',
          device: 'cpu',
          maxCandidates: 20,
          batchSize: 8,
        },
      },
      onWarn: (message) => warnings.push(message),
    });

    expect(retriever.id).toBe('embedding');
    const hits = await retriever.search('4090', { sessionKey: 'cli:d', limit: 5 });

    expect(hits.map((hit) => hit.id)).toEqual(['a']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('模型文件缺失');
  });

  it('limit、80 字去重与 400 字注入截断保持不变', async () => {
    const store = makeStore();
    const long = `4090 ${'长'.repeat(460)}`;
    const prefix = '相' + '同'.repeat(90);
    store.append({ id: 'long', src: 'cli', sessionKey: 'cli:e', role: 'user', text: long, t: clock - 3 });
    store.append({ id: 'dup1', src: 'cli', sessionKey: 'cli:e', role: 'user', text: `${prefix}甲`, t: clock - 2 });
    store.append({ id: 'dup2', src: 'cli', sessionKey: 'cli:e', role: 'user', text: `${prefix}乙`, t: clock - 1 });
    const embedder = new FakeEmbedder(new Map([['4090', [1, 0]]]));

    const hits = await hybrid(store, embedder).search('4090', {
      sessionKey: 'cli:e',
      limit: 5,
    });

    expect(hits.map((hit) => hit.id).filter((id) => id.startsWith('dup'))).toHaveLength(1);
    const longHit = hits.find((hit) => hit.id === 'long')!;
    expect(Array.from(longHit.text).length).toBeLessThanOrEqual(400 + 13);
    expect(longHit.text.endsWith('…[truncated]')).toBe(true);
  });

  it('stats 复用 bigram 的文档计数', () => {
    const store = makeStore();
    store.append({ id: 'a', src: 'cli', sessionKey: 'cli:f', role: 'user', text: '4090', t: clock });
    const retriever = hybrid(store, new FakeEmbedder(new Map()));
    expect(retriever.stats()).toEqual({ docs: 1 });
  });
});

describe('createRetriever', () => {
  it('默认 bigram 不构造 embedding 运行时', async () => {
    const store = makeStore();
    store.append({ id: 'a', src: 'cli', sessionKey: 'cli:g', role: 'user', text: '4090', t: clock });
    const retriever = createRetriever({
      store,
      recall: {
        engine: 'bigram',
        embedding: {
          modelDir: join(dir, 'missing-model'),
          dtype: 'q8',
          device: 'cpu',
          maxCandidates: 20,
          batchSize: 8,
        },
      },
    });

    expect(retriever.id).toBe('bigram');
    const hits = await retriever.search('4090', { sessionKey: 'cli:g', limit: 5 });
    expect(hits.map((hit) => hit.id)).toEqual(['a']);
  });
});

describe('model integrity', () => {
  it('模型文件损坏时拒绝加载，不会进入 native runtime', async () => {
    const modelDir = join(dir, 'bad-model');
    for (const file of BGE_MODEL_FILES) {
      const target = join(modelDir, file.path);
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, 'not-the-model');
    }
    const embedder = new BgeSmallZhEmbedder({ modelDir });

    await expect(embedder.embed(['4090'], 'query')).rejects.toThrow(/模型文件大小不符/);
  });

  it('verifyModelFiles 对正确文件返回 ok', async () => {
    const modelDir = join(dir, 'tiny-model');
    mkdirSync(modelDir, { recursive: true });
    const content = 'tiny model placeholder';
    writeFileSync(join(modelDir, 'a.bin'), content);
    const files: ModelFileSpec[] = [
      {
        path: 'a.bin',
        bytes: Buffer.byteLength(content),
        sha256: createHash('sha256').update(content).digest('hex').toUpperCase(),
      },
    ];

    await expect(verifyModelFiles(modelDir, files)).resolves.toEqual({ ok: true });
  });

  it('verifyModelFiles 拒绝大小不符与哈希不符', async () => {
    const modelDir = join(dir, 'checksum-model');
    mkdirSync(modelDir, { recursive: true });
    const content = 'checksum placeholder';
    writeFileSync(join(modelDir, 'a.bin'), content);
    const base: ModelFileSpec = {
      path: 'a.bin',
      bytes: Buffer.byteLength(content),
      sha256: '0'.repeat(64),
    };

    await expect(verifyModelFiles(modelDir, [base])).resolves.toEqual({
      ok: false,
      reason: '模型文件哈希不符：a.bin',
    });
    await expect(
      verifyModelFiles(modelDir, [{ ...base, bytes: base.bytes + 1 }]),
    ).resolves.toEqual({
      ok: false,
      reason: '模型文件大小不符：a.bin',
    });
  });

  it('仓库 manifest 与运行时信任锚一致', () => {
    const manifest = JSON.parse(
      readFileSync(
        new URL('../../models/bge-small-zh-v1.5-onnx/manifest.json', import.meta.url),
        'utf8',
      ),
    ) as { files: ModelFileSpec[] };

    expect(manifest.files).toEqual([...BGE_MODEL_FILES]);
  });
});
