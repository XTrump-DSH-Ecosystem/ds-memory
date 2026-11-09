import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ConfigError,
  defaultRuntimeDir,
  loadConfig,
  stripComments,
} from '../../src/config/load.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'xds-config-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('loadConfig', () => {
  it('没有任何配置文件时回退内置默认值，stateDir 相对 rootDir 解析', () => {
    const loaded = loadConfig(dir);

    expect(loaded.source).toBe('builtin');
    expect(loaded.path).toBeNull();
    expect(loaded.config.provider.default).toBe('deepseek');
    expect(loaded.config.provider.deepseek.model).toBe('deepseek-flash');
    expect(loaded.config.stateDir).toBe(resolve(dir, 'state'));
    expect(loaded.config.agent.compaction).toEqual({
      enabled: true,
      idleMs: 1_800_000,
      thresholdTokens: 24_000,
      minTurns: 6,
    });
    expect(loaded.config.memory.recall.engine).toBe('bigram');
    expect(loaded.config.memory.recall.embedding).toEqual({
      modelDir: resolve(dir, 'models/bge-small-zh-v1.5-onnx'),
      dtype: 'q8',
      device: 'cpu',
      maxCandidates: 20,
      batchSize: 8,
    });
    expect(loaded.config.codeBridge).toEqual({
      enabled: false,
      endpointFile: join(defaultRuntimeDir(), 'code-bridge.endpoint.json'),
      tokenFile: join(defaultRuntimeDir(), 'code-bridge.token'),
      requestTimeoutMs: 5000,
      pollIntervalMs: 2000,
      summaryMaxChars: 1200,
    });
    expect(isAbsolute(loaded.config.codeBridge.endpointFile)).toBe(true);
    expect(isAbsolute(loaded.config.codeBridge.tokenFile)).toBe(true);
    expect(loaded.config.webSearch).toEqual({
      enabled: false,
      engines: ['baidu', 'sogou'],
      endpointFile: join(defaultRuntimeDir(), 'open-websearch.endpoint.json'),
      deepseek: {
        enabled: false,
        baseUrl: 'https://api.deepseek.com/v1/tools',
        apiKeyEnv: 'DEEPSEEK_API_KEY',
        count: 10,
        timeoutMs: 30_000,
      },
    });
    expect(isAbsolute(loaded.config.webSearch.endpointFile)).toBe(true);
  });

  it('显式 deepseek-chat 原样保留，不做隐式 fallback', () => {
    writeFileSync(
      join(dir, 'config.jsonc'),
      JSON.stringify({ provider: { deepseek: { model: 'deepseek-chat' } } }),
      'utf8',
    );

    expect(loadConfig(dir).config.provider.deepseek.model).toBe('deepseek-chat');
  });

  it('codeBridge 文件相对配置文件目录解析，绝对路径原样保留', () => {
    writeFileSync(
      join(dir, 'config.jsonc'),
      JSON.stringify({
        codeBridge: {
          endpointFile: './runtime/bridge.endpoint.json',
          tokenFile: './runtime/bridge.token',
        },
      }),
      'utf8',
    );

    expect(loadConfig(dir).config.codeBridge).toMatchObject({
      endpointFile: resolve(dir, 'runtime/bridge.endpoint.json'),
      tokenFile: resolve(dir, 'runtime/bridge.token'),
    });

    const absolute = process.platform === 'win32' ? 'D:/DSH/secret.token' : '/tmp/secret.token';
    writeFileSync(
      join(dir, 'config.jsonc'),
      JSON.stringify({ codeBridge: { tokenFile: absolute } }),
      'utf8',
    );
    expect(loadConfig(dir).config.codeBridge.tokenFile).toBe(resolve(absolute));
  });

  it('config.jsonc 缺失时回退 config.example.jsonc', () => {
    writeFileSync(join(dir, 'config.example.jsonc'), '{ "stateDir": "./example-state" }', 'utf8');

    const loaded = loadConfig(dir);

    expect(loaded.source).toBe('config.example.jsonc');
    expect(loaded.config.stateDir).toBe(resolve(dir, 'example-state'));
  });

  it('坏配置明确指出键名', () => {
    writeFileSync(
      join(dir, 'config.jsonc'),
      '{ "provider": { "default": "其他" } }',
      'utf8',
    );

    try {
      loadConfig(dir);
      expect.fail('应当抛 ConfigError');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as Error).message).toContain('provider.default');
    }
  });

  it('非法 JSON 给出明确报错', () => {
    writeFileSync(join(dir, 'config.jsonc'), '{ "stateDir": }', 'utf8');

    expect(() => loadConfig(dir)).toThrow(ConfigError);
    expect(() => loadConfig(dir)).toThrow(/不是合法 JSON/);
  });

  it('注释被剥离，但字符串里的 // 保留', () => {
    writeFileSync(
      join(dir, 'config.jsonc'),
      `/* 头部
         注释 */
       {
         // 行注释
         "provider": {
           "deepseek": {
             "baseUrl": "https://api.deepseek.com", // 根地址
             "model": "deepseek-chat" /* 行内 */
           }
         },
         "stateDir": "./state"
       }`,
      'utf8',
    );

    const loaded = loadConfig(dir);

    expect(loaded.config.provider.deepseek.baseUrl).toBe('https://api.deepseek.com');
    expect(loaded.config.provider.deepseek.model).toBe('deepseek-chat');
    expect(loaded.config.provider.deepseek.apiKeyEnv).toBe('DEEPSEEK_API_KEY');
    expect(loaded.config.provider.deepseek.timeoutMs).toBe(120_000);
  });

  it('部分嵌套配置会补齐默认值', () => {
    writeFileSync(
      join(dir, 'config.jsonc'),
      '{ "provider": { "deepseek": { "model": "deepseek-reasoner" } } }',
      'utf8',
    );

    const loaded = loadConfig(dir);

    expect(loaded.config.provider.default).toBe('deepseek');
    expect(loaded.config.provider.deepseek.model).toBe('deepseek-reasoner');
    expect(loaded.config.provider.deepseek.baseUrl).toBe('https://api.deepseek.com');
    expect(loaded.config.provider.dsh.profile).toBe('desktop');
    expect(loaded.config.qq.allowGroups).toEqual([]);
  });

  it('embedding.modelDir 相对配置文件目录解析，绝对路径原样保留', () => {
    writeFileSync(
      join(dir, 'config.jsonc'),
      JSON.stringify({ memory: { recall: { embedding: { modelDir: './models/custom' } } } }),
      'utf8',
    );
    expect(loadConfig(dir).config.memory.recall.embedding.modelDir).toBe(
      resolve(dir, 'models/custom'),
    );

    const absolute = process.platform === 'win32' ? 'E:/models/custom' : '/models/custom';
    writeFileSync(
      join(dir, 'config.jsonc'),
      JSON.stringify({ memory: { recall: { embedding: { modelDir: absolute } } } }),
      'utf8',
    );
    expect(loadConfig(dir).config.memory.recall.embedding.modelDir).toBe(resolve(absolute));
  });

  it('非法 embedding 配置被 zod 拒绝并指出键名', () => {
    const cases: Array<[unknown, string]> = [
      [{ memory: { recall: { engine: 'faiss' } } }, 'memory.recall.engine'],
      [{ memory: { recall: { embedding: { maxCandidates: 0 } } } }, 'memory.recall.embedding.maxCandidates'],
      [{ memory: { recall: { embedding: { batchSize: 65 } } } }, 'memory.recall.embedding.batchSize'],
      [{ memory: { recall: { embedding: { dtype: 'fp32' } } } }, 'memory.recall.embedding.dtype'],
    ];
    for (const [value, key] of cases) {
      writeFileSync(join(dir, 'config.jsonc'), JSON.stringify(value), 'utf8');
      try {
        loadConfig(dir);
        expect.fail(`应当拒绝：${key}`);
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        expect((err as Error).message).toContain(key);
      }
    }
  });

  it('qq 未配置时使用完整默认值', () => {
    const { runtimeDir, ...qq } = loadConfig(dir).config.qq;

    expect(qq).toEqual({
      enabled: false,
      hookHost: '127.0.0.1',
      hookPort: 985,
      hookToken: '',
      gatewayUrl: '',
      batchWindowMs: 2000,
      batchMaxMessages: 12,
      batchMessageMaxChars: 300,
      batchMaxChars: 4000,
      dedupeTtlMs: 600_000,
      ownerQQ: 0,
      allowGroups: [],
      denyPrivate: [],
      denyGroups: [],
      groupMemberReply: {
        enabled: true,
        minIntervalMs: 3000,
        maxPerMinute: 6,
      },
      groupWake: 'mention',
      send: {
        maxPerTurn: 3,
        retryDelaysMs: [2000, 10000],
        sendTimeoutMs: 10_000,
      },
      healthIntervalMs: 30_000,
      snowluma: {
        httpUrl: 'http://127.0.0.1:3000',
        wsUrl: 'ws://127.0.0.1:3001',
        homeDir: '',
      },
    });
    expect(runtimeDir).toBe(defaultRuntimeDir());
    expect(isAbsolute(runtimeDir)).toBe(true);
  });

  it('旧 qq 配置兼容：snowluma 保留解析，其余字段补默认值', () => {
    writeFileSync(
      join(dir, 'config.jsonc'),
      JSON.stringify({
        qq: {
          ownerQQ: 123456,
          allowGroups: [1001, 1002],
          snowluma: {
            httpUrl: 'http://127.0.0.1:3999',
            wsUrl: 'ws://127.0.0.1:3998',
            homeDir: 'D:/snowluma',
          },
        },
      }),
      'utf8',
    );

    const { qq } = loadConfig(dir).config;

    expect(qq.enabled).toBe(false);
    expect(qq.hookPort).toBe(985);
    expect(qq.ownerQQ).toBe(123456);
    expect(qq.allowGroups).toEqual([1001, 1002]);
    expect(qq.snowluma).toEqual({
      httpUrl: 'http://127.0.0.1:3999',
      wsUrl: 'ws://127.0.0.1:3998',
      homeDir: 'D:/snowluma',
    });
  });

  it('qq.gatewayUrl 允许空串（端点发现模式），显式 URL 覆盖优先', () => {
    writeFileSync(
      join(dir, 'config.jsonc'),
      JSON.stringify({ qq: { gatewayUrl: '' } }),
      'utf8',
    );
    expect(loadConfig(dir).config.qq.gatewayUrl).toBe('');

    writeFileSync(
      join(dir, 'config.jsonc'),
      JSON.stringify({ qq: { gatewayUrl: 'http://127.0.0.1:9999' } }),
      'utf8',
    );
    expect(loadConfig(dir).config.qq.gatewayUrl).toBe('http://127.0.0.1:9999');
  });

  it('qq.gatewayUrl 非空时仅接受 http://127.0.0.1:<port>', () => {
    for (const value of [
      'http://127.0.0.1:803',
      'http://127.0.0.1:803/',
      'http://127.0.0.1:80',
      'http://127.0.0.1:65535',
    ]) {
      writeFileSync(
        join(dir, 'config.jsonc'),
        JSON.stringify({ qq: { gatewayUrl: value } }),
        'utf8',
      );
      expect(loadConfig(dir).config.qq.gatewayUrl).toBe(value);
    }

    const rejected = [
      'https://127.0.0.1:803',
      'http://127.0.0.1',
      'http://127.0.0.1:0',
      'http://127.0.0.1:65536',
      'http://localhost:803',
      'http://192.168.1.10:803',
      'http://[::1]:803',
      'http://user@127.0.0.1:803',
      'http://user:pass@127.0.0.1:803',
      'http://127.0.0.1:803/path',
      'http://127.0.0.1:803?query=1',
      'http://127.0.0.1:803#fragment',
      '127.0.0.1:803',
      'http://',
      'ws://127.0.0.1:803',
    ];
    for (const value of rejected) {
      writeFileSync(
        join(dir, 'config.jsonc'),
        JSON.stringify({ qq: { gatewayUrl: value } }),
        'utf8',
      );
      try {
        loadConfig(dir);
        expect.fail(`应当拒绝 gatewayUrl：${value}`);
      } catch (err) {
        const message = (err as Error).message;
        expect(err).toBeInstanceOf(ConfigError);
        expect(message).toContain('qq.gatewayUrl');
        expect(message).toContain('http://127.0.0.1:<port>');
      }
    }
  });

  it('qq.gatewayUrl 报错不回显配置原值', () => {
    const secretUrl = 'http://192.168.1.10:803/?token=super-secret-placeholder';
    writeFileSync(
      join(dir, 'config.jsonc'),
      JSON.stringify({ qq: { gatewayUrl: secretUrl } }),
      'utf8',
    );

    try {
      loadConfig(dir);
      expect.fail('应当拒绝非回环 gatewayUrl');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('qq.gatewayUrl');
      expect(message).not.toContain('super-secret-placeholder');
      expect(message).not.toContain('192.168.1.10');
    }
  });

  it('qq.runtimeDir 用户配置覆盖时原样使用', () => {
    const custom = process.platform === 'win32' ? 'D:/DSH/custom-runtime' : '/tmp/dsh-custom-runtime';
    writeFileSync(
      join(dir, 'config.jsonc'),
      JSON.stringify({ qq: { runtimeDir: custom } }),
      'utf8',
    );

    expect(loadConfig(dir).config.qq.runtimeDir).toBe(custom);
  });

  it('qq.runtimeDir 拒绝相对路径', () => {
    for (const value of ['./runtime', 'runtime', '../runtime']) {
      writeFileSync(
        join(dir, 'config.jsonc'),
        JSON.stringify({ qq: { runtimeDir: value } }),
        'utf8',
      );
      try {
        loadConfig(dir);
        expect.fail(`应当拒绝相对 runtimeDir：${value}`);
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        expect((err as Error).message).toContain('qq.runtimeDir');
      }
    }
  });

  it('webSearch 默认关闭，endpointFile 由 qq.runtimeDir 派生', () => {
    const custom =
      process.platform === 'win32' ? 'D:/DSH/custom-runtime' : '/tmp/dsh-custom-runtime';
    writeFileSync(
      join(dir, 'config.jsonc'),
      JSON.stringify({ qq: { runtimeDir: custom } }),
      'utf8',
    );

    const { webSearch } = loadConfig(dir).config;

    expect(webSearch).toEqual({
      enabled: false,
      engines: ['baidu', 'sogou'],
      endpointFile: join(custom, 'open-websearch.endpoint.json'),
      deepseek: {
        enabled: false,
        baseUrl: 'https://api.deepseek.com/v1/tools',
        apiKeyEnv: 'DEEPSEEK_API_KEY',
        count: 10,
        timeoutMs: 30_000,
      },
    });
  });

  it('webSearch.endpointFile 相对路径按配置目录解析，绝对路径原样保留', () => {
    writeFileSync(
      join(dir, 'config.jsonc'),
      JSON.stringify({ webSearch: { endpointFile: './runtime/web.endpoint.json' } }),
      'utf8',
    );
    expect(loadConfig(dir).config.webSearch.endpointFile).toBe(
      resolve(dir, 'runtime/web.endpoint.json'),
    );

    const absolute =
      process.platform === 'win32' ? 'D:/DSH/web.endpoint.json' : '/tmp/web.endpoint.json';
    writeFileSync(
      join(dir, 'config.jsonc'),
      JSON.stringify({ webSearch: { endpointFile: absolute } }),
      'utf8',
    );
    expect(loadConfig(dir).config.webSearch.endpointFile).toBe(resolve(absolute));
  });

  it('非法 webSearch 配置被 zod 拒绝并指出键名', () => {
    const cases: Array<[unknown, string]> = [
      [{ webSearch: { enabled: 'yes' } }, 'webSearch.enabled'],
      [{ webSearch: { endpointFile: 123 } }, 'webSearch.endpointFile'],
      [{ webSearch: { engines: [] } }, 'webSearch.engines'],
      [{ webSearch: { engines: ['unknown-engine'] } }, 'webSearch.engines'],
      [
        { webSearch: { deepseek: { enabled: 'yes' } } },
        'webSearch.deepseek.enabled',
      ],
      [
        { webSearch: { deepseek: { baseUrl: 'not-a-url' } } },
        'webSearch.deepseek.baseUrl',
      ],
      [
        { webSearch: { deepseek: { apiKeyEnv: '' } } },
        'webSearch.deepseek.apiKeyEnv',
      ],
      [
        { webSearch: { deepseek: { count: 0 } } },
        'webSearch.deepseek.count',
      ],
      [
        { webSearch: { deepseek: { timeoutMs: 0 } } },
        'webSearch.deepseek.timeoutMs',
      ],
    ];

    for (const [value, key] of cases) {
      writeFileSync(join(dir, 'config.jsonc'), JSON.stringify(value), 'utf8');
      try {
        loadConfig(dir);
        expect.fail(`应当拒绝：${key}`);
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        expect((err as Error).message).toContain(key);
      }
    }
  });

  it('连续加载返回独立的 qq 嵌套对象（不受上一次修改影响）', () => {
    const first = loadConfig(dir).config.qq;
    first.allowGroups.push(999);
    first.denyPrivate.push(998);
    first.denyGroups.push(997);
    first.groupMemberReply.maxPerMinute = 99;
    first.send.retryDelaysMs.push(30_000);
    first.send.maxPerTurn = 99;
    first.snowluma.homeDir = 'X:/changed';

    const second = loadConfig(dir).config.qq;

    expect(second.allowGroups).toEqual([]);
    expect(second.denyPrivate).toEqual([]);
    expect(second.denyGroups).toEqual([]);
    expect(second.groupMemberReply.maxPerMinute).toBe(6);
    expect(second.send.retryDelaysMs).toEqual([2000, 10000]);
    expect(second.send.maxPerTurn).toBe(3);
    expect(second.snowluma.homeDir).toBe('');

    expect(first).not.toBe(second);
    expect(first.allowGroups).not.toBe(second.allowGroups);
    expect(first.denyPrivate).not.toBe(second.denyPrivate);
    expect(first.denyGroups).not.toBe(second.denyGroups);
    expect(first.groupMemberReply).not.toBe(second.groupMemberReply);
    expect(first.send).not.toBe(second.send);
    expect(first.send.retryDelaysMs).not.toBe(second.send.retryDelaysMs);
    expect(first.snowluma).not.toBe(second.snowluma);
  });

  it('qq.enabled=true 时空 hookToken 启动失败，且报错不回显 token', () => {
    writeFileSync(
      join(dir, 'config.jsonc'),
      JSON.stringify({ qq: { enabled: true, ownerQQ: 123456, hookToken: '' } }),
      'utf8',
    );

    try {
      loadConfig(dir);
      expect.fail('应当抛 ConfigError');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as Error).message).toContain('qq.hookToken');
    }
  });

  it('qq.enabled=true 时 ownerQQ=0 启动失败', () => {
    writeFileSync(
      join(dir, 'config.jsonc'),
      JSON.stringify({ qq: { enabled: true, hookToken: 'test-token-placeholder' } }),
      'utf8',
    );

    try {
      loadConfig(dir);
      expect.fail('应当抛 ConfigError');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as Error).message).toContain('qq.ownerQQ');
      expect((err as Error).message).not.toContain('test-token-placeholder');
    }
  });

  it('qq.enabled=true 且关键配置齐全时通过', () => {
    writeFileSync(
      join(dir, 'config.jsonc'),
      JSON.stringify({
        qq: {
          enabled: true,
          hookToken: 'test-token-placeholder',
          ownerQQ: 123456,
          hookPort: 4123,
        },
      }),
      'utf8',
    );

    const { qq } = loadConfig(dir).config;

    expect(qq.enabled).toBe(true);
    expect(qq.hookPort).toBe(4123);
    expect(qq.ownerQQ).toBe(123456);
  });

  it('qq.enabled=false 时不触发启动校验（CLI 默认行为不变）', () => {
    writeFileSync(
      join(dir, 'config.jsonc'),
      JSON.stringify({ qq: { enabled: false, hookToken: '', ownerQQ: 0 } }),
      'utf8',
    );

    const { qq } = loadConfig(dir).config;

    expect(qq.enabled).toBe(false);
    expect(qq.hookToken).toBe('');
    expect(qq.ownerQQ).toBe(0);
  });

  it('qq.send.maxPerTurn 允许 0（静音），负数仍被拒绝', () => {
    writeFileSync(
      join(dir, 'config.jsonc'),
      JSON.stringify({ qq: { send: { maxPerTurn: 0 } } }),
      'utf8',
    );
    expect(loadConfig(dir).config.qq.send.maxPerTurn).toBe(0);

    writeFileSync(
      join(dir, 'config.jsonc'),
      JSON.stringify({ qq: { send: { maxPerTurn: -1 } } }),
      'utf8',
    );
    expect(() => loadConfig(dir)).toThrow(/qq\.send\.maxPerTurn/);
  });

  it('非法 qq 配置被 zod 拒绝并指出键名', () => {
    const cases: Array<[unknown, string]> = [
      [{ qq: { hookPort: 0 } }, 'qq.hookPort'],
      [{ qq: { hookPort: 65536 } }, 'qq.hookPort'],
      [{ qq: { enabled: true, hookToken: 'x', ownerQQ: 1, hookPort: 0 } }, 'qq.hookPort'],
      [{ qq: { dedupeTtlMs: 359_999 } }, 'qq.dedupeTtlMs'],
      [{ qq: { groupWake: '每一条' } }, 'qq.groupWake'],
      [{ qq: { send: { sendTimeoutMs: 0 } } }, 'qq.send.sendTimeoutMs'],
      [{ qq: { healthIntervalMs: -1 } }, 'qq.healthIntervalMs'],
    ];

    for (const [value, key] of cases) {
      writeFileSync(join(dir, 'config.jsonc'), JSON.stringify(value), 'utf8');
      expect(() => loadConfig(dir)).toThrow(new RegExp(key));
    }
  });
});

describe('stripComments', () => {
  it('转义引号里的 // 不当作注释', () => {
    const input = '{ "stateDir": "a//b", "x": "\\"//y\\"" }';
    expect(JSON.parse(stripComments(input))).toEqual({ stateDir: 'a//b', x: '"//y"' });
  });
});
