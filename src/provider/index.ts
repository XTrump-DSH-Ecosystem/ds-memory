import { DeepSeekProvider } from './deepseek.ts';
import { DshProvider } from './dsh.ts';
import type { Provider } from './types.ts';

/** 只声明本层需要的配置切片，避免 provider 反向依赖 config 模块。 */
export interface ProviderSelection {
  default: 'deepseek' | 'dsh';
  deepseek: {
    baseUrl: string;
    model: string;
    apiKeyEnv: string;
    timeoutMs: number;
  };
  dsh: {
    autoDiscover: boolean;
    profile: string;
  };
}

export function createProvider(selection: ProviderSelection): Provider {
  switch (selection.default) {
    case 'deepseek':
      return new DeepSeekProvider(selection.deepseek);
    case 'dsh':
      return new DshProvider(selection.dsh);
  }
}
