import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { validateExplicitGatewayUrl } from '../qq/discovery.ts';

// ---------- 默认值（README「配置一览」的数字出处） ----------

const DEEPSEEK_DEFAULTS = {
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  apiKeyEnv: 'DEEPSEEK_API_KEY',
  timeoutMs: 120_000,
};

const DSH_DEFAULTS = { autoDiscover: true, profile: 'desktop' };

const FACTS_DEFAULTS = {
  injectMax: 30,
  injectMaxChars: 900,
  halfLifeDays: 45,
  archiveThreshold: 1,
  autoReview: true,
};

const RECALL_DEFAULTS = {
  engine: 'bigram',
  trigger: 'auto',
  budgetChars: 600,
  budgetItems: 5,
} as const;

const EMBEDDING_DEFAULTS = {
  modelDir: 'models/bge-small-zh-v1.5-onnx',
  dtype: 'q8',
  device: 'cpu',
  maxCandidates: 20,
  batchSize: 8,
} as const;

const SELF_NOTE_DEFAULTS = { max: 40, bootstrapLimit: 20 };

const COMPACTION_DEFAULTS = {
  enabled: true,
  idleMs: 1_800_000,
  thresholdTokens: 24_000,
  minTurns: 6,
};

const SNOWLUMA_DEFAULTS = {
  httpUrl: 'http://127.0.0.1:3000',
  wsUrl: 'ws://127.0.0.1:3001',
  homeDir: '',
};

const QQ_SEND_DEFAULTS = {
  maxPerTurn: 3,
  retryDelaysMs: [2000, 10000],
  sendTimeoutMs: 10_000,
};

const CODE_BRIDGE_DEFAULTS = {
  enabled: false,
  endpointFile: '',
  tokenFile: '',
  requestTimeoutMs: 5000,
  pollIntervalMs: 2000,
  summaryMaxChars: 1200,
};

const WEB_SEARCH_ENGINE_VALUES = [
  'baidu',
  'bing',
  'sogou',
  'duckduckgo',
  'exa',
  'brave',
  'startpage',
  'csdn',
  'juejin',
  'linuxdo',
  'hackernews',
] as const;

const WEB_SEARCH_DEFAULTS = {
  enabled: false,
  endpointFile: '',
  /** Bing 对中文常按单字切词；百度 + 搜狗互为补充与故障回退。 */
  engines: ['baidu', 'sogou'] as Array<(typeof WEB_SEARCH_ENGINE_VALUES)[number]>,
  /**
   * DeepSeek Search/Fetch API 直连；失败或未配置凭据时回退 open-websearch。
   * 默认关闭，避免没有 DEEPSEEK_API_KEY 的部署在测试/本地环境产生网络请求。
   */
  deepseek: {
    enabled: false,
    baseUrl: 'https://api.deepseek.com/v1/tools',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    count: 10,
    timeoutMs: 30_000,
  },
};

/**
 * 运行时目录（端点发现用）：
 * - Windows：%LOCALAPPDATA%\DSH\runtime
 * - 其他：$XDG_RUNTIME_DIR/dsh，缺失时 ~/.dsh/runtime
 */
export function defaultRuntimeDir(): string {
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA?.trim();
    const base = localAppData && localAppData.length > 0
      ? localAppData
      : join(homedir(), 'AppData', 'Local');
    return resolve(join(base, 'DSH', 'runtime'));
  }

  const xdgRuntimeDir = process.env.XDG_RUNTIME_DIR?.trim();
  if (xdgRuntimeDir && xdgRuntimeDir.length > 0) {
    return resolve(join(xdgRuntimeDir, 'dsh'));
  }
  return resolve(join(homedir(), '.dsh', 'runtime'));
}

const QQ_DEFAULTS = {
  enabled: false,
  hookHost: '127.0.0.1',
  // 首选端口；绑定失败（EADDRINUSE/EACCES）时由服务层回退到 0 由系统分配。
  hookPort: 985,
  hookToken: '',
  // 空串 = 端点发现模式；显式 URL 覆盖优先。
  gatewayUrl: '',
  runtimeDir: defaultRuntimeDir(),
  batchWindowMs: 2000,
  batchMaxMessages: 12,
  batchMessageMaxChars: 300,
  batchMaxChars: 4000,
  dedupeTtlMs: 600_000,
  ownerQQ: 0,
  allowGroups: [] as number[],
  denyPrivate: [] as number[],
  denyGroups: [] as number[],
  groupWake: 'mention' as const,
  groupMemberReply: {
    enabled: true,
    minIntervalMs: 3_000,
    maxPerMinute: 6,
  },
  send: QQ_SEND_DEFAULTS,
  healthIntervalMs: 30_000,
  snowluma: SNOWLUMA_DEFAULTS,
};

/** 完整默认对象（数组/嵌套对象做浅拷贝，避免共享可变引用）。 */
function defaultQqConfig() {
  return {
    ...QQ_DEFAULTS,
    allowGroups: [...QQ_DEFAULTS.allowGroups],
    denyPrivate: [...QQ_DEFAULTS.denyPrivate],
    denyGroups: [...QQ_DEFAULTS.denyGroups],
    groupMemberReply: { ...QQ_DEFAULTS.groupMemberReply },
    send: {
      ...QQ_SEND_DEFAULTS,
      retryDelaysMs: [...QQ_SEND_DEFAULTS.retryDelaysMs],
    },
    snowluma: { ...SNOWLUMA_DEFAULTS },
  };
}

// ---------- schema ----------
// P0 只消费 provider 与 stateDir；memory/agent/qq 仅定义形状与默认值，P1/P2 再消费。

const deepseekSchema = z.object({
  baseUrl: z.string().url().default(DEEPSEEK_DEFAULTS.baseUrl),
  model: z.string().min(1).default(DEEPSEEK_DEFAULTS.model),
  apiKeyEnv: z.string().min(1).default(DEEPSEEK_DEFAULTS.apiKeyEnv),
  timeoutMs: z.number().int().positive().default(DEEPSEEK_DEFAULTS.timeoutMs),
});

const dshSchema = z.object({
  autoDiscover: z.boolean().default(DSH_DEFAULTS.autoDiscover),
  profile: z.string().min(1).default(DSH_DEFAULTS.profile),
});

const providerSchema = z.object({
  default: z.enum(['deepseek', 'dsh']).default('deepseek'),
  deepseek: deepseekSchema.default({ ...DEEPSEEK_DEFAULTS }),
  dsh: dshSchema.default({ ...DSH_DEFAULTS }),
});

const factsSchema = z.object({
  injectMax: z.number().int().positive().default(FACTS_DEFAULTS.injectMax),
  injectMaxChars: z.number().int().positive().default(FACTS_DEFAULTS.injectMaxChars),
  halfLifeDays: z.number().positive().default(FACTS_DEFAULTS.halfLifeDays),
  archiveThreshold: z.number().nonnegative().default(FACTS_DEFAULTS.archiveThreshold),
  autoReview: z.boolean().default(FACTS_DEFAULTS.autoReview),
});

const recallSchema = z.object({
  engine: z.enum(['bigram', 'embedding']).default(RECALL_DEFAULTS.engine),
  trigger: z.enum(['auto', 'off']).default(RECALL_DEFAULTS.trigger),
  budgetChars: z.number().int().positive().default(RECALL_DEFAULTS.budgetChars),
  budgetItems: z.number().int().positive().default(RECALL_DEFAULTS.budgetItems),
  embedding: z
    .object({
      modelDir: z.string().min(1).default(EMBEDDING_DEFAULTS.modelDir),
      dtype: z.enum(['q8']).default(EMBEDDING_DEFAULTS.dtype),
      device: z.enum(['cpu']).default(EMBEDDING_DEFAULTS.device),
      maxCandidates: z
        .number()
        .int()
        .positive()
        .max(100)
        .default(EMBEDDING_DEFAULTS.maxCandidates),
      batchSize: z
        .number()
        .int()
        .positive()
        .max(64)
        .default(EMBEDDING_DEFAULTS.batchSize),
    })
    .default({ ...EMBEDDING_DEFAULTS }),
});

const selfNoteSchema = z.object({
  max: z.number().int().positive().default(SELF_NOTE_DEFAULTS.max),
  bootstrapLimit: z.number().int().positive().default(SELF_NOTE_DEFAULTS.bootstrapLimit),
});

const memorySchema = z.object({
  facts: factsSchema.default({ ...FACTS_DEFAULTS }),
  recall: recallSchema.default(() => ({
    ...RECALL_DEFAULTS,
    embedding: { ...EMBEDDING_DEFAULTS },
  })),
  selfNote: selfNoteSchema.default({ ...SELF_NOTE_DEFAULTS }),
});

const compactionSchema = z.object({
  enabled: z.boolean().default(COMPACTION_DEFAULTS.enabled),
  idleMs: z.number().int().positive().default(COMPACTION_DEFAULTS.idleMs),
  thresholdTokens: z.number().int().positive().default(COMPACTION_DEFAULTS.thresholdTokens),
  minTurns: z.number().int().positive().default(COMPACTION_DEFAULTS.minTurns),
});

const agentSchema = z.object({
  compaction: compactionSchema.default({ ...COMPACTION_DEFAULTS }),
});

const snowlumaSchema = z.object({
  httpUrl: z.string().url().default(SNOWLUMA_DEFAULTS.httpUrl),
  wsUrl: z.string().default(SNOWLUMA_DEFAULTS.wsUrl),
  homeDir: z.string().default(SNOWLUMA_DEFAULTS.homeDir),
});

const qqSendSchema = z.object({
  maxPerTurn: z.number().int().nonnegative().default(QQ_SEND_DEFAULTS.maxPerTurn),
  retryDelaysMs: z
    .array(z.number().int().nonnegative())
    .default([...QQ_SEND_DEFAULTS.retryDelaysMs]),
  sendTimeoutMs: z.number().int().positive().default(QQ_SEND_DEFAULTS.sendTimeoutMs),
});

const qqSchema = z
  .object({
    enabled: z.boolean().default(QQ_DEFAULTS.enabled),
    hookHost: z.string().min(1).default(QQ_DEFAULTS.hookHost),
    hookPort: z.number().int().min(1).max(65535).default(QQ_DEFAULTS.hookPort),
    hookToken: z.string().default(QQ_DEFAULTS.hookToken),
    gatewayUrl: z
      .string()
      .default(QQ_DEFAULTS.gatewayUrl)
      .superRefine((value, ctx) => {
        if (value === '') return;
        const validated = validateExplicitGatewayUrl(value);
        if (!validated.valid) {
          ctx.addIssue({
            code: 'custom',
            message: `必须为空（端点发现模式）或 http://127.0.0.1:<port>（${validated.reason}）`,
          });
        }
      }),
    runtimeDir: z
      .string()
      .default(QQ_DEFAULTS.runtimeDir)
      .refine((value) => isAbsolute(value), {
        message: '必须是绝对路径',
      }),
    batchWindowMs: z.number().int().positive().default(QQ_DEFAULTS.batchWindowMs),
    batchMaxMessages: z
      .number()
      .int()
      .positive()
      .default(QQ_DEFAULTS.batchMaxMessages),
    batchMessageMaxChars: z
      .number()
      .int()
      .positive()
      .default(QQ_DEFAULTS.batchMessageMaxChars),
    batchMaxChars: z.number().int().positive().default(QQ_DEFAULTS.batchMaxChars),
    dedupeTtlMs: z.number().int().min(360_000).default(QQ_DEFAULTS.dedupeTtlMs),
    ownerQQ: z.number().int().nonnegative().default(QQ_DEFAULTS.ownerQQ),
    allowGroups: z.array(z.number().int()).default([...QQ_DEFAULTS.allowGroups]),
    denyPrivate: z.array(z.number().int()).default([...QQ_DEFAULTS.denyPrivate]),
    denyGroups: z.array(z.number().int()).default([...QQ_DEFAULTS.denyGroups]),
    groupWake: z.enum(['mention', 'all']).default(QQ_DEFAULTS.groupWake),
    groupMemberReply: z
      .object({
        enabled: z.boolean().default(QQ_DEFAULTS.groupMemberReply.enabled),
        minIntervalMs: z
          .number()
          .int()
          .nonnegative()
          .default(QQ_DEFAULTS.groupMemberReply.minIntervalMs),
        maxPerMinute: z
          .number()
          .int()
          .positive()
          .default(QQ_DEFAULTS.groupMemberReply.maxPerMinute),
      })
      .default({ ...QQ_DEFAULTS.groupMemberReply }),
    send: qqSendSchema.default({
      ...QQ_SEND_DEFAULTS,
      retryDelaysMs: [...QQ_SEND_DEFAULTS.retryDelaysMs],
    }),
    healthIntervalMs: z.number().int().positive().default(QQ_DEFAULTS.healthIntervalMs),
    /** 已废弃：仅保留 P1 配置解析兼容，P2 不消费；彻底删除另立小任务。 */
    snowluma: snowlumaSchema.default({ ...SNOWLUMA_DEFAULTS }),
  })
  .superRefine((qq, ctx) => {
    // QQ 关闭时不做启动校验，保证 CLI 默认行为完全不变。
    if (!qq.enabled) return;

    if (qq.hookToken.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['hookToken'],
        message: 'qq.enabled=true 时 hookToken 不能为空',
      });
    }

    if (qq.ownerQQ === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['ownerQQ'],
        message: 'qq.enabled=true 时 ownerQQ 必须为非 0 的 QQ 号',
      });
    }
  });

const codeBridgeSchema = z.object({
  enabled: z.boolean().default(CODE_BRIDGE_DEFAULTS.enabled),
  /** 空 = defaultRuntimeDir()/code-bridge.endpoint.json。 */
  endpointFile: z.string().default(CODE_BRIDGE_DEFAULTS.endpointFile),
  /** 空 = defaultRuntimeDir()/code-bridge.token。 */
  tokenFile: z.string().default(CODE_BRIDGE_DEFAULTS.tokenFile),
  requestTimeoutMs: z
    .number()
    .int()
    .positive()
    .default(CODE_BRIDGE_DEFAULTS.requestTimeoutMs),
  pollIntervalMs: z
    .number()
    .int()
    .positive()
    .default(CODE_BRIDGE_DEFAULTS.pollIntervalMs),
  summaryMaxChars: z
    .number()
    .int()
    .positive()
    .default(CODE_BRIDGE_DEFAULTS.summaryMaxChars),
});

const webSearchSchema = z.object({
  enabled: z.boolean().default(WEB_SEARCH_DEFAULTS.enabled),
  /** 空 = qq.runtimeDir/open-websearch.endpoint.json。 */
  endpointFile: z.string().default(WEB_SEARCH_DEFAULTS.endpointFile),
  /** 传给 open-websearch 的搜索引擎列表；顺序即优先级。 */
  engines: z
    .array(z.enum(WEB_SEARCH_ENGINE_VALUES))
    .min(1)
    .max(4)
    .default([...WEB_SEARCH_DEFAULTS.engines]),
  deepseek: z
    .object({
      enabled: z.boolean().default(WEB_SEARCH_DEFAULTS.deepseek.enabled),
      baseUrl: z.string().url().default(WEB_SEARCH_DEFAULTS.deepseek.baseUrl),
      apiKeyEnv: z
        .string()
        .min(1)
        .default(WEB_SEARCH_DEFAULTS.deepseek.apiKeyEnv),
      count: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(WEB_SEARCH_DEFAULTS.deepseek.count),
      timeoutMs: z
        .number()
        .int()
        .positive()
        .default(WEB_SEARCH_DEFAULTS.deepseek.timeoutMs),
    })
    .default({ ...WEB_SEARCH_DEFAULTS.deepseek }),
});

const configSchema = z.object({
  provider: providerSchema.default({
    default: 'deepseek',
    deepseek: { ...DEEPSEEK_DEFAULTS },
    dsh: { ...DSH_DEFAULTS },
  }),
  memory: memorySchema.default({
    facts: { ...FACTS_DEFAULTS },
    recall: {
      ...RECALL_DEFAULTS,
      embedding: { ...EMBEDDING_DEFAULTS },
    },
    selfNote: { ...SELF_NOTE_DEFAULTS },
  }),
  agent: agentSchema.default({ compaction: { ...COMPACTION_DEFAULTS } }),
  qq: qqSchema.default(defaultQqConfig()),
  codeBridge: codeBridgeSchema.default({ ...CODE_BRIDGE_DEFAULTS }),
  webSearch: webSearchSchema.default({ ...WEB_SEARCH_DEFAULTS }),
  stateDir: z.string().min(1).default('./state'),
});

export type AppConfig = z.infer<typeof configSchema>;
export type ConfigSource = 'config.jsonc' | 'config.example.jsonc' | 'builtin';

export interface LoadedConfig {
  config: AppConfig;
  source: ConfigSource;
  /** 实际读取的文件绝对路径；使用内置默认值时是 null。 */
  path: string | null;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * 去掉 JSONC 注释（// 与 \/* *\/），保留换行以便报错定位。
 * 字符串内部的 // 不会被误删。40 行以内，不引库。
 */
export function stripComments(text: string): string {
  let out = '';
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    const next = text[i + 1];

    if (inLineComment) {
      if (ch === '\n') {
        inLineComment = false;
        out += ch;
      }
      continue;
    }

    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i += 1;
      } else if (ch === '\n') {
        out += ch;
      }
      continue;
    }

    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }

    if (ch === '/' && next === '/') {
      inLineComment = true;
      i += 1;
      continue;
    }

    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i += 1;
      continue;
    }

    out += ch;
  }

  return out;
}

function formatIssues(issues: z.ZodIssue[]): string[] {
  return issues.map((issue) => {
    const key = issue.path.length > 0 ? issue.path.join('.') : '(根)';
    return `${key}：${issue.message}`;
  });
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 读取 <rootDir>/config.jsonc；不存在则回退 config.example.jsonc；两者都没有时用内置默认值。
 * stateDir 会相对 rootDir 解析成绝对路径，避免受启动目录影响。
 */
export function loadConfig(rootDir: string = process.cwd()): LoadedConfig {
  const candidates: Array<[Exclude<ConfigSource, 'builtin'>, string]> = [
    ['config.jsonc', join(rootDir, 'config.jsonc')],
    ['config.example.jsonc', join(rootDir, 'config.example.jsonc')],
  ];

  const hit = candidates.find(([, file]) => existsSync(file));

  if (!hit) {
    const config = structuredClone(configSchema.parse({}));
    return {
      config: resolvePaths(config, rootDir),
      source: 'builtin',
      path: null,
    };
  }

  const [source, file] = hit;
  let json: unknown;
  try {
    json = JSON.parse(stripComments(readFileSync(file, 'utf8')));
  } catch (err) {
    throw new ConfigError(
      `配置文件 ${basename(file)} 不是合法 JSON（注释剥离后）：${messageOf(err)}`,
    );
  }

  const parsed = configSchema.safeParse(json);
  if (!parsed.success) {
    const lines = formatIssues(parsed.error.issues).map((line) => `  - ${line}`);
    throw new ConfigError(
      `配置文件 ${basename(file)} 校验失败：\n${lines.join('\n')}`,
    );
  }

  const data = structuredClone(parsed.data);
  return {
    config: resolvePaths(data, rootDir),
    source,
    path: file,
  };
}

/** 配置里的相对路径统一相对配置文件所在目录解析，避免受启动目录影响。 */
function resolvePaths(config: AppConfig, rootDir: string): AppConfig {
  const runtimeDir = defaultRuntimeDir();
  const endpointFile =
    config.codeBridge.endpointFile.trim() === ''
      ? join(runtimeDir, 'code-bridge.endpoint.json')
      : resolve(rootDir, config.codeBridge.endpointFile);
  const tokenFile =
    config.codeBridge.tokenFile.trim() === ''
      ? join(runtimeDir, 'code-bridge.token')
      : resolve(rootDir, config.codeBridge.tokenFile);
  const webSearchEndpointFile =
    config.webSearch.endpointFile.trim() === ''
      ? join(config.qq.runtimeDir, 'open-websearch.endpoint.json')
      : resolve(rootDir, config.webSearch.endpointFile);

  return {
    ...config,
    stateDir: resolve(rootDir, config.stateDir),
    codeBridge: {
      ...config.codeBridge,
      endpointFile,
      tokenFile,
    },
    webSearch: {
      ...config.webSearch,
      endpointFile: webSearchEndpointFile,
    },
    memory: {
      ...config.memory,
      recall: {
        ...config.memory.recall,
        embedding: {
          ...config.memory.recall.embedding,
          modelDir: resolve(rootDir, config.memory.recall.embedding.modelDir),
        },
      },
    },
  };
}
