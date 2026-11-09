import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const WEB_SEARCH_ENDPOINT_FILENAME = 'open-websearch.endpoint.json';
export const WEB_SEARCH_VERSION = '2.2.0' as const;
export const WEB_SEARCH_HOST = '127.0.0.1' as const;

const MAX_ENDPOINT_FILE_BYTES = 64 * 1024;

export interface WebSearchEndpoint {
  v: 1;
  name: 'open-websearch';
  host: typeof WEB_SEARCH_HOST;
  port: number;
  pid: number;
  instanceId: string;
  startedAt: string;
  version: typeof WEB_SEARCH_VERSION;
  baseUrl: string;
}

export type WebSearchEndpointInvalidReason =
  | 'missing_file'
  | 'unreadable'
  | 'parse_error'
  | 'missing_fields'
  | 'invalid_types'
  | 'invalid_version'
  | 'invalid_name'
  | 'non_loopback_host'
  | 'port_out_of_range'
  | 'pid_dead'
  | 'invalid_instance_id'
  | 'invalid_started_at'
  | 'invalid_daemon_version'
  | 'base_url_mismatch';

export type WebSearchEndpointValidation =
  | { valid: true; endpoint: WebSearchEndpoint }
  | { valid: false; reason: WebSearchEndpointInvalidReason };

export interface WebSearchEndpointParseOptions {
  pidAlive?: (pid: number) => boolean;
}

export function webSearchEndpointPath(runtimeDir: string): string {
  return join(runtimeDir, WEB_SEARCH_ENDPOINT_FILENAME);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasRequiredFields(value: Record<string, unknown>): boolean {
  return (
    value.v !== undefined &&
    value.name !== undefined &&
    value.host !== undefined &&
    value.port !== undefined &&
    value.pid !== undefined &&
    value.instanceId !== undefined &&
    value.startedAt !== undefined &&
    value.version !== undefined &&
    value.baseUrl !== undefined
  );
}

/** 结构校验 open-websearch 端点；身份字段必须与冻结契约完全一致。 */
export function parseWebSearchEndpoint(
  value: unknown,
  options: WebSearchEndpointParseOptions = {},
): WebSearchEndpointValidation {
  if (!isRecord(value)) return { valid: false, reason: 'invalid_types' };
  if (!hasRequiredFields(value)) return { valid: false, reason: 'missing_fields' };

  if (
    typeof value.v !== 'number' ||
    !Number.isInteger(value.v) ||
    typeof value.name !== 'string' ||
    typeof value.host !== 'string' ||
    typeof value.port !== 'number' ||
    !Number.isInteger(value.port) ||
    typeof value.pid !== 'number' ||
    !Number.isInteger(value.pid) ||
    typeof value.instanceId !== 'string' ||
    typeof value.startedAt !== 'string' ||
    typeof value.version !== 'string' ||
    typeof value.baseUrl !== 'string'
  ) {
    return { valid: false, reason: 'invalid_types' };
  }

  if (value.v !== 1) return { valid: false, reason: 'invalid_version' };
  if (value.name !== 'open-websearch') return { valid: false, reason: 'invalid_name' };
  if (value.host !== WEB_SEARCH_HOST) {
    return { valid: false, reason: 'non_loopback_host' };
  }
  if (value.port < 1 || value.port > 65535) {
    return { valid: false, reason: 'port_out_of_range' };
  }
  if (value.pid <= 0) return { valid: false, reason: 'pid_dead' };
  if (value.instanceId.length === 0 || value.instanceId.length > 200) {
    return { valid: false, reason: 'invalid_instance_id' };
  }
  if (
    value.startedAt.length === 0 ||
    value.startedAt.length > 64 ||
    Number.isNaN(Date.parse(value.startedAt))
  ) {
    return { valid: false, reason: 'invalid_started_at' };
  }
  if (value.version !== WEB_SEARCH_VERSION) {
    return { valid: false, reason: 'invalid_daemon_version' };
  }

  const expectedBaseUrl = `http://${WEB_SEARCH_HOST}:${value.port}`;
  if (value.baseUrl !== expectedBaseUrl) {
    return { valid: false, reason: 'base_url_mismatch' };
  }
  if (options.pidAlive) {
    let alive = false;
    try {
      alive = options.pidAlive(value.pid);
    } catch {
      alive = false;
    }
    if (!alive) return { valid: false, reason: 'pid_dead' };
  }

  return {
    valid: true,
    endpoint: {
      v: 1,
      name: 'open-websearch',
      host: WEB_SEARCH_HOST,
      port: value.port,
      pid: value.pid,
      instanceId: value.instanceId,
      startedAt: value.startedAt,
      version: WEB_SEARCH_VERSION,
      baseUrl: expectedBaseUrl,
    },
  };
}

/** 进程存活判断；EPERM 视为存在（只是无权限探测）。 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function readWebSearchEndpoint(
  filePath: string,
  options: WebSearchEndpointParseOptions = {},
): WebSearchEndpointValidation {
  try {
    const stat = statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_ENDPOINT_FILE_BYTES) {
      return { valid: false, reason: 'unreadable' };
    }
  } catch (err) {
    return {
      valid: false,
      reason: (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing_file' : 'unreadable',
    };
  }

  let value: unknown;
  try {
    value = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return { valid: false, reason: 'parse_error' };
  }

  return parseWebSearchEndpoint(value, {
    pidAlive: options.pidAlive ?? isProcessAlive,
  });
}
