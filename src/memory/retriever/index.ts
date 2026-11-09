import type { EventStore } from '../store.ts';
import { BigramRetriever } from './bigram.ts';
import { BgeSmallZhEmbedder, type Embedder } from './embedding.ts';
import { HybridRetriever, type AliasGroup } from './hybrid.ts';
import type { Retriever } from './types.ts';

export interface RecallSettings {
  engine: 'bigram' | 'embedding';
  embedding: {
    modelDir: string;
    dtype: 'q8';
    device: 'cpu';
    maxCandidates: number;
    batchSize: number;
  };
}

export interface CreateRetrieverOptions {
  store: EventStore;
  ownerQQ?: number;
  now?: () => number;
  recall: RecallSettings;
  onWarn?: (message: string) => void;
  onInfo?: (message: string) => void;
  /** 测试注入口；生产不传，按配置构造 BGE。 */
  embedder?: Embedder;
  /** 测试注入口；生产默认使用受控生产别名表。 */
  aliases?: readonly AliasGroup[];
}

/**
 * 三条入口（CLI、serve、QQ）共用同一个工厂，避免检索器接线漂移。
 * engine=bigram 时不构造 embedding 运行时，连模块都不会加载。
 */
export function createRetriever(options: CreateRetrieverOptions): Retriever {
  const common = {
    store: options.store,
    ...(options.ownerQQ !== undefined ? { ownerQQ: options.ownerQQ } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  };

  if (options.recall.engine === 'bigram') {
    return new BigramRetriever(common);
  }

  const embedder =
    options.embedder ??
    new BgeSmallZhEmbedder({
      modelDir: options.recall.embedding.modelDir,
      batchSize: options.recall.embedding.batchSize,
      ...(options.onInfo !== undefined ? { onInfo: options.onInfo } : {}),
    });
  return new HybridRetriever({
    ...common,
    embedder,
    ...(options.aliases !== undefined ? { aliases: options.aliases } : {}),
    maxCandidates: options.recall.embedding.maxCandidates,
    ...(options.onWarn !== undefined ? { onWarn: options.onWarn } : {}),
  });
}
