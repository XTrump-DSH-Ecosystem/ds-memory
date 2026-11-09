import {
  ProviderError,
  usageOfEvent,
  type ChatEvent,
  type ChatEventStream,
  type ChatRequest,
  type Provider,
  type TokenUsage,
} from './types.ts';

export interface DshOptions {
  autoDiscover: boolean;
  profile: string;
}

/**
 * DSH 桌面端 provider —— P0 只注册骨架。
 * 完整实现（.credentials.yaml 铸 Cookie、动态端口发现）属于 P1/P2，未开工。
 */
export class DshProvider implements Provider {
  readonly id = 'dsh' as const;
  readonly supportsTools = false;
  private readonly options: DshOptions;

  constructor(options: DshOptions) {
    this.options = options;
  }

  chat(req: ChatRequest, opts: { signal: AbortSignal }): ChatEventStream {
    void req;
    void opts;
    throw new ProviderError('DSH provider 在 P0 仅注册骨架，chat() 尚未实现');
  }

  usageOf(event: ChatEvent): TokenUsage | null {
    return usageOfEvent(event);
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    return {
      ok: false,
      detail: `DSH provider 未实现（P0 骨架，profile=${this.options.profile}）`,
    };
  }
}
