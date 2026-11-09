import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  GATEWAY_ENDPOINT_FILENAME,
  GatewayDiscovery,
  resolveGatewayEndpoint,
  validateEndpointFile,
  validateExplicitGatewayUrl,
} from '../../src/qq/discovery.ts';

const FIXTURE_DIR = new URL('../contract/endpoint/', import.meta.url);

function fixture(name: string): { payload: unknown; expect: Record<string, unknown> } {
  return JSON.parse(readFileSync(new URL(name, FIXTURE_DIR), 'utf8')) as {
    payload: unknown;
    expect: Record<string, unknown>;
  };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'xds-discovery-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeEndpoint(overrides: Record<string, unknown> = {}): void {
  writeFileSync(
    join(dir, GATEWAY_ENDPOINT_FILENAME),
    JSON.stringify({
      v: 1,
      name: 'qq-gateway',
      host: '127.0.0.1',
      port: 803,
      pid: 12345,
      startedAt: 1_750_000_000_000,
      instanceId: '11111111-1111-4111-8111-111111111111',
      ...overrides,
    }),
    'utf8',
  );
}

describe('validateEndpointFile', () => {
  it.each([
    ['valid-qq-gateway.json', true, null],
    ['invalid-dead-pid.json', false, 'pid_dead'],
    ['invalid-missing-fields.json', false, 'missing_fields'],
    ['invalid-non-loopback.json', false, 'non_loopback_host'],
    ['invalid-port.json', false, 'port_out_of_range'],
    ['invalid-types.json', false, 'invalid_types'],
  ])('契约 fixture %s', (name, valid, reason) => {
    const loaded = fixture(name);
    const result = validateEndpointFile(loaded.payload, {
      isPidAlive: () => name !== 'invalid-dead-pid.json',
    });

    expect(result.valid).toBe(valid);
    if (!result.valid) expect(result.reason).toBe(reason);
  });

  it('拒绝 ds-memory 端点文件（name 不匹配）', () => {
    const loaded = fixture('valid-ds-memory.json');
    const result = validateEndpointFile(loaded.payload, {
      expectedName: 'qq-gateway',
      isPidAlive: () => true,
    });

    expect(result).toEqual({ valid: false, reason: 'name_mismatch' });
  });

  it('不接受 localhost / 非回环 / 版本不符', () => {
    const base = fixture('valid-qq-gateway.json').payload as Record<string, unknown>;

    expect(
      validateEndpointFile({ ...base, host: 'localhost' }, { isPidAlive: () => true }),
    ).toEqual({ valid: false, reason: 'non_loopback_host' });
    expect(
      validateEndpointFile({ ...base, host: '0.0.0.0' }, { isPidAlive: () => true }),
    ).toEqual({ valid: false, reason: 'non_loopback_host' });
    expect(
      validateEndpointFile({ ...base, v: 2 }, { isPidAlive: () => true }),
    ).toEqual({ valid: false, reason: 'unsupported_version' });
  });
});

describe('validateExplicitGatewayUrl', () => {
  it.each([
    ['http://127.0.0.1:803', true, 'http://127.0.0.1:803'],
    ['http://127.0.0.1:803/', true, 'http://127.0.0.1:803'],
    ['http://127.0.0.1:80', true, 'http://127.0.0.1:80'],
    ['http://127.0.0.1:65535', true, 'http://127.0.0.1:65535'],
  ])('接受回环显式 URL：%s', (value, valid, baseUrl) => {
    const result = validateExplicitGatewayUrl(value);
    expect(result.valid).toBe(valid);
    if (result.valid) expect(result.baseUrl).toBe(baseUrl);
  });

  it.each([
    ['', 'invalid_url'],
    ['https://127.0.0.1:803', 'invalid_url'],
    ['http://127.0.0.1', 'invalid_url'],
    ['http://127.0.0.1:/', 'invalid_url'],
    ['http://127.0.0.1:0', 'invalid_url'],
    ['http://127.0.0.1:65536', 'invalid_url'],
    ['http://localhost:803', 'non_loopback_host'],
    ['http://192.168.1.10:803', 'non_loopback_host'],
    ['http://[::1]:803', 'non_loopback_host'],
    ['ftp://127.0.0.1:803', 'invalid_url'],
    ['not a url', 'invalid_url'],
    ['http://user@127.0.0.1:803', 'url_credentials_not_allowed'],
    ['http://127.0.0.1:803/path', 'url_path_not_allowed'],
    ['http://user:pass@127.0.0.1:803', 'url_credentials_not_allowed'],
    ['http://127.0.0.1:803?token=secret', 'url_path_not_allowed'],
    ['http://127.0.0.1:803#fragment', 'url_path_not_allowed'],
    ['http://127.0.0.1:803/extra/', 'url_path_not_allowed'],
    ['http://127.0.0.1:803/.', 'invalid_url'],
    ['http://127.0.0.1:803/%2e', 'invalid_url'],
  ])('拒绝非法显式 URL：%s', (value, reason) => {
    expect(validateExplicitGatewayUrl(value)).toEqual({ valid: false, reason });
  });
});

describe('resolveGatewayEndpoint', () => {
  it('显式 URL 优先，即使端点文件存在', () => {
    writeEndpoint();

    const result = resolveGatewayEndpoint({
      gatewayUrl: 'http://127.0.0.1:9999',
      runtimeDir: dir,
    });

    expect(result).toEqual({ kind: 'explicit', baseUrl: 'http://127.0.0.1:9999' });
  });

  it('显式 URL 非法时不回退端点文件', () => {
    writeEndpoint();

    const result = resolveGatewayEndpoint({
      gatewayUrl: 'http://localhost:9999',
      runtimeDir: dir,
    });

    expect(result).toEqual({ kind: 'offline', reason: 'explicit_url_invalid' });
  });

  it('端点文件缺失按离线处理', () => {
    expect(
      resolveGatewayEndpoint({ gatewayUrl: '', runtimeDir: dir, isPidAlive: () => true }),
    ).toEqual({ kind: 'offline', reason: 'endpoint_missing' });
  });

  it('合法端点文件返回 127.0.0.1 基址', () => {
    writeEndpoint({ port: 901 });

    const result = resolveGatewayEndpoint({
      gatewayUrl: '',
      runtimeDir: dir,
      isPidAlive: () => true,
    });

    expect(result).toMatchObject({
      kind: 'endpoint',
      baseUrl: 'http://127.0.0.1:901',
      endpoint: { host: '127.0.0.1', port: 901 },
    });
  });

  it('pid 已死按离线处理', () => {
    writeEndpoint({ pid: 2147483646 });

    expect(
      resolveGatewayEndpoint({ gatewayUrl: '', runtimeDir: dir, isPidAlive: () => false }),
    ).toEqual({ kind: 'offline', reason: 'pid_dead' });
  });

  it('非法 JSON 端点文件按离线处理', () => {
    writeFileSync(join(dir, GATEWAY_ENDPOINT_FILENAME), '{ broken', 'utf8');

    expect(
      resolveGatewayEndpoint({ gatewayUrl: '', runtimeDir: dir, isPidAlive: () => true }),
    ).toEqual({ kind: 'offline', reason: 'endpoint_invalid_json' });
  });

  it('文件变化后重新解析得到新端口', () => {
    const discovery = new GatewayDiscovery({
      gatewayUrl: '',
      runtimeDir: dir,
      isPidAlive: () => true,
    });

    writeEndpoint({ port: 803 });
    expect(discovery.resolve()).toMatchObject({ baseUrl: 'http://127.0.0.1:803' });

    writeEndpoint({ port: 804, instanceId: '22222222-2222-4222-8222-222222222222' });
    expect(discovery.resolve()).toMatchObject({ baseUrl: 'http://127.0.0.1:804' });
  });

  it('读取失败（非 ENOENT）按离线处理', () => {
    const result = resolveGatewayEndpoint({
      gatewayUrl: '',
      runtimeDir: dir,
      readFile: () => {
        const err = new Error('permission denied') as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      },
    });

    expect(result).toEqual({ kind: 'offline', reason: 'endpoint_unreadable' });
  });
});
