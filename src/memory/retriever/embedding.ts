import { basename, dirname, join } from 'node:path';
import {
  BGE_MODEL_DIMENSION,
  BGE_MODEL_FILES,
  verifyModelFiles,
} from './embedding-model.ts';

export type EmbedKind = 'query' | 'document';

export interface Embedder {
  /** 运行时 id，进入日志与测试断言，不进入线上契约。 */
  readonly id: string;
  embed(texts: readonly string[], kind: EmbedKind): Promise<number[][]>;
}

interface TensorLike {
  data: ArrayLike<number>;
}

type FeatureExtractor = (
  input: string | string[],
  options: { pooling: 'cls'; normalize: boolean },
) => Promise<TensorLike>;

export interface BgeEmbedderOptions {
  modelDir: string;
  batchSize?: number;
  onInfo?: (message: string) => void;
}

/**
 * bge-small-zh-v1.5 q8 的进程内实现。
 *
 * - 首次调用才加载 native runtime 与模型，默认 bigram 启动零额外开销
 * - 加载前核对模型文件哈希；allowRemoteModels=false，绝不联网下载
 * - 任一步失败都抛错，由 HybridRetriever 统一降级到 bigram
 */
export class BgeSmallZhEmbedder implements Embedder {
  readonly id = 'bge-small-zh-v1.5-q8';

  private readonly modelDir: string;
  private readonly batchSize: number;
  private readonly onInfo?: (message: string) => void;
  private extractor: FeatureExtractor | null = null;
  private loading: Promise<FeatureExtractor> | null = null;

  constructor(options: BgeEmbedderOptions) {
    this.modelDir = options.modelDir;
    this.batchSize = options.batchSize ?? 8;
    this.onInfo = options.onInfo;
  }

  async embed(texts: readonly string[], _kind: EmbedKind): Promise<number[][]> {
    const extractor = await this.ensureLoaded();
    const out: number[][] = [];

    for (let start = 0; start < texts.length; start += this.batchSize) {
      const batch = texts.slice(start, start + this.batchSize);
      if (batch.length === 0) continue;
      const result = await extractor(batch.length === 1 ? batch[0]! : batch, {
        pooling: 'cls',
        normalize: true,
      });
      const values = Array.from(result.data);
      const expected = batch.length * BGE_MODEL_DIMENSION;
      if (values.length !== expected) {
        throw new Error(
          `embedding 输出维度异常：期望 ${expected}，实际 ${values.length}`,
        );
      }
      for (let index = 0; index < batch.length; index += 1) {
        out.push(values.slice(index * BGE_MODEL_DIMENSION, (index + 1) * BGE_MODEL_DIMENSION));
      }
    }

    if (out.length !== texts.length) {
      throw new Error(`embedding 返回数量异常：期望 ${texts.length}，实际 ${out.length}`);
    }
    return out;
  }

  private ensureLoaded(): Promise<FeatureExtractor> {
    if (this.extractor) return Promise.resolve(this.extractor);
    if (this.loading) return this.loading;
    this.loading = this.load().catch((err: unknown) => {
      this.loading = null;
      throw err;
    });
    return this.loading;
  }

  private async load(): Promise<FeatureExtractor> {
    const verified = await verifyModelFiles(this.modelDir, BGE_MODEL_FILES);
    if (!verified.ok) throw new Error(verified.reason);

    const startedAt = performance.now();
    const transformers = await import('@huggingface/transformers');
    transformers.env.localModelPath = dirname(this.modelDir);
    transformers.env.cacheDir = join(dirname(this.modelDir), '.transformers-cache');
    transformers.env.allowRemoteModels = false;
    transformers.env.allowLocalModels = true;

    const pipeline = await transformers.pipeline('feature-extraction', basename(this.modelDir), {
      dtype: 'q8',
      device: 'cpu',
    });
    const extractor = pipeline as unknown as FeatureExtractor;

    const probe = await extractor('检索探针', { pooling: 'cls', normalize: true });
    if (Array.from(probe.data).length !== BGE_MODEL_DIMENSION) {
      throw new Error('embedding 模型维度不是 512，拒绝启用');
    }

    this.extractor = extractor;
    this.onInfo?.(
      `embedding 模型已加载：${basename(this.modelDir)}（${(performance.now() - startedAt).toFixed(0)}ms）`,
    );
    return extractor;
  }
}
