import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** 网关端点文件名（CONTRACT v1.1 §5.2）。 */
export const GATEWAY_ENDPOINT_FILENAME = 'qq-gateway.endpoint.json';

/** 唯一允许连接的回环字面量；不接受 localhost / IPv6。 */
export const LOOPBACK_HOST = '127.0.0.1';

export type EndpointName = 'ds-memory' | 'qq-gateway';

export interface EndpointFile {
  v: 1;
  name: EndpointName;
  host: '127.0.0.1';
  port: number;
  pid: number;
  startedAt: number;
  instanceId: string;
}

export interface GatewayEndpoint extends EndpointFile {
  name: 'qq-gateway';
}

export type EndpointInvalidReason =
  | 'missing_fields'
  | 'invalid_types'
  | 'unsupported_version'
  | 'name_mismatch'
  | 'non_loopback_host'
  | 'port_out_of_range'
  | 'pid_dead';

export type EndpointValidation =
  | { valid: true; endpoint: EndpointFile }
  | { valid: false; reason: EndpointInvalidReason };

export interface EndpointValidationOptions {
  /** 指定期望的对端名称；缺省接受 ds-memory / qq-gateway 任一合法名称。 */
  expectedName?: EndpointName;
  /** 注入 PID 存活判断（测试用）；默认 process.kill(pid, 0)。 */
  isPidAlive?: (pid: number) => boolean;
  /** 是否检查 pid 存活；默认 true。 */
  checkPid?: boolean;
}

const REQUIRED_ENDPOINT_FIELDS = [
  'v',
  'name',
  'host',
  'port',
  'pid',
  'startedAt',
  'instanceId',
] as const;

/** PID 存活判断：EPERM 表示进程存在但当前用户无权限发信号。 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * 校验端点文件形状与回环/PID 约束。
 * 只接受字面量 127.0.0.1，绝不接受 localhost 或非回环地址。
 */
export function validateEndpointFile(
  value: unknown,
  options: EndpointValidationOptions = {},
): EndpointValidation {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { valid: false, reason: 'invalid_types' };
  }

  const record = value as Record<string, unknown>;
  if (REQUIRED_ENDPOINT_FIELDS.some((field) => !(field in record))) {
    return { valid: false, reason: 'missing_fields' };
  }

  if (typeof record.v !== 'number' || !Number.isInteger(record.v)) {
    return { valid: false, reason: 'invalid_types' };
  }
  if (record.v !== 1) {
    return { valid: false, reason: 'unsupported_version' };
  }

  if (typeof record.name !== 'string') {
    return { valid: false, reason: 'invalid_types' };
  }
  if (record.name !== 'ds-memory' && record.name !== 'qq-gateway') {
    return { valid: false, reason: 'invalid_types' };
  }
  if (options.expectedName !== undefined && record.name !== options.expectedName) {
    return { valid: false, reason: 'name_mismatch' };
  }

  if (
    typeof record.host !== 'string' ||
    typeof record.port !== 'number' ||
    !Number.isInteger(record.port) ||
    typeof record.pid !== 'number' ||
    !Number.isInteger(record.pid) ||
    record.pid <= 0 ||
    typeof record.startedAt !== 'number' ||
    !Number.isFinite(record.startedAt) ||
    typeof record.instanceId !== 'string' ||
    record.instanceId.length === 0
  ) {
    return { valid: false, reason: 'invalid_types' };
  }

  if (record.host !== LOOPBACK_HOST) {
    return { valid: false, reason: 'non_loopback_host' };
  }
  if (record.port < 1 || record.port > 65_535) {
    return { valid: false, reason: 'port_out_of_range' };
  }

  const checkPid = options.checkPid ?? true;
  const pidAlive = options.isPidAlive ?? isProcessAlive;
  if (checkPid && !pidAlive(record.pid)) {
    return { valid: false, reason: 'pid_dead' };
  }

  return {
    valid: true,
    endpoint: {
      v: 1,
      name: record.name,
      host: LOOPBACK_HOST,
      port: record.port,
      pid: record.pid,
      startedAt: record.startedAt,
      instanceId: record.instanceId,
    },
  };
}

export type ExplicitUrlInvalidReason =
  | 'invalid_url'
  | 'non_loopback_host'
  | 'url_path_not_allowed'
  | 'url_credentials_not_allowed';

export type ExplicitUrlValidation =
  | { valid: true; baseUrl: string }
  | { valid: false; reason: ExplicitUrlInvalidReason };

/** 显式 URL 只接受 http://127.0.0.1:<port> 形式的裸 origin。 */
export function validateExplicitGatewayUrl(value: string): ExplicitUrlValidation {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { valid: false, reason: 'invalid_url' };
  }

  if (url.protocol !== 'http:') {
    return { valid: false, reason: 'invalid_url' };
  }
  if (url.username.length > 0 || url.password.length > 0) {
    return { valid: false, reason: 'url_credentials_not_allowed' };
  }
  if (url.hostname !== LOOPBACK_HOST) {
    return { valid: false, reason: 'non_loopback_host' };
  }
  if (url.pathname !== '/' || url.search.length > 0 || url.hash.length > 0) {
    return { valid: false, reason: 'url_path_not_allowed' };
  }

  // URL 会省略默认端口（例如 :80），因此从原始字符串确认端口确实显式给出。
  const canonical = /^http:\/\/127\.0\.0\.1:(\d+)\/?$/.exec(value);
  if (!canonical) return { valid: false, reason: 'invalid_url' };

  const port = Number(canonical[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return { valid: false, reason: 'invalid_url' };
  }

  return { valid: true, baseUrl: `http://${LOOPBACK_HOST}:${port}` };
}

export type GatewayOfflineReason =
  | 'explicit_url_invalid'
  | 'endpoint_missing'
  | 'endpoint_unreadable'
  | 'endpoint_invalid_json'
  | EndpointInvalidReason;

export type GatewayResolution =
  | { kind: 'explicit'; baseUrl: string }
  | { kind: 'endpoint'; baseUrl: string; endpoint: GatewayEndpoint }
  | { kind: 'offline'; reason: GatewayOfflineReason };

export interface GatewayDiscoveryOptions {
  /** 空串 = 端点发现模式；非空为显式覆盖。 */
  gatewayUrl: string;
  runtimeDir: string;
  isPidAlive?: (pid: number) => boolean;
  /** 注入文件读取（测试用）；默认 readFileSync(..., 'utf8')。 */
  readFile?: (path: string) => string;
}

function defaultReadFile(path: string): string {
  return readFileSync(path, 'utf8');
}

/**
 * 解析网关基址。每次调用都会重新读取端点文件，因此调用方在连接失败后
 * 重新调用即可获得文件变化后的新地址；文件缺失或 pid 已死返回 offline。
 */
export function resolveGatewayEndpoint(options: GatewayDiscoveryOptions): GatewayResolution {
  if (options.gatewayUrl !== '') {
    const explicit = validateExplicitGatewayUrl(options.gatewayUrl);
    return explicit.valid
      ? { kind: 'explicit', baseUrl: explicit.baseUrl }
      : { kind: 'offline', reason: 'explicit_url_invalid' };
  }

  const path = join(options.runtimeDir, GATEWAY_ENDPOINT_FILENAME);
  const readFile = options.readFile ?? defaultReadFile;

  let text: string;
  try {
    text = readFile(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return {
      kind: 'offline',
      reason: code === 'ENOENT' ? 'endpoint_missing' : 'endpoint_unreadable',
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: 'offline', reason: 'endpoint_invalid_json' };
  }

  const validation = validateEndpointFile(parsed, {
    expectedName: 'qq-gateway',
    isPidAlive: options.isPidAlive,
  });
  if (!validation.valid) {
    return { kind: 'offline', reason: validation.reason };
  }

  if (validation.endpoint.name !== 'qq-gateway') {
    return { kind: 'offline', reason: 'name_mismatch' };
  }
  const endpoint: GatewayEndpoint = { ...validation.endpoint, name: 'qq-gateway' };
  return {
    kind: 'endpoint',
    baseUrl: `http://${endpoint.host}:${endpoint.port}`,
    endpoint,
  };
}

/** 有状态包装；`resolve()` 每次重新读盘，不做端点缓存。 */
export class GatewayDiscovery {
  private readonly options: GatewayDiscoveryOptions;

  constructor(options: GatewayDiscoveryOptions) {
    this.options = options;
  }

  resolve(): GatewayResolution {
    return resolveGatewayEndpoint(this.options);
  }
}
