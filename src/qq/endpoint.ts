import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

/** 只允许绑定/连接字面量回环地址。 */
export const LOOPBACK_HOST = '127.0.0.1' as const;

export type EndpointName = 'ds-memory' | 'qq-gateway';

export interface EndpointInfo {
  v: 1;
  name: EndpointName;
  host: typeof LOOPBACK_HOST;
  port: number;
  pid: number;
  startedAt: number;
  instanceId: string;
}

export type EndpointInvalidReason =
  | 'missing_file'
  | 'parse_error'
  | 'missing_fields'
  | 'invalid_types'
  | 'invalid_version'
  | 'invalid_name'
  | 'name_mismatch'
  | 'non_loopback_host'
  | 'port_out_of_range'
  | 'pid_dead';

export type EndpointValidation =
  | { valid: true; endpoint: EndpointInfo }
  | { valid: false; reason: EndpointInvalidReason };

export interface EndpointParseOptions {
  /** 只接受指定端点名（例如 ds-memory 读 qq-gateway 文件时传 qq-gateway）。 */
  expectedName?: EndpointName;
  /** 运行时发现可注入存活判断；缺省只做结构与回环校验。 */
  pidAlive?: (pid: number) => boolean;
}

export function endpointFileName(name: EndpointName): string {
  return `${name}.endpoint.json`;
}

export function endpointPath(runtimeDir: string, name: EndpointName): string {
  return join(runtimeDir, endpointFileName(name));
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
    value.startedAt !== undefined &&
    value.instanceId !== undefined
  );
}

/**
 * 结构校验端点文件；可选检查 name 与 pid 存活。
 * 缺省不探测 pid，避免把「结构合法但此刻进程未启动」的 fixture 误判；
 * 运行时发现应传入 `pidAlive` 或另行调用 `isProcessAlive()`。
 */
export function parseEndpoint(
  value: unknown,
  options: EndpointParseOptions = {},
): EndpointValidation {
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
    typeof value.startedAt !== 'number' ||
    !Number.isFinite(value.startedAt) ||
    typeof value.instanceId !== 'string' ||
    value.instanceId.length === 0
  ) {
    return { valid: false, reason: 'invalid_types' };
  }
  if (value.v !== 1) return { valid: false, reason: 'invalid_version' };
  if (value.name !== 'ds-memory' && value.name !== 'qq-gateway') {
    return { valid: false, reason: 'invalid_name' };
  }
  if (options.expectedName !== undefined && value.name !== options.expectedName) {
    return { valid: false, reason: 'name_mismatch' };
  }
  if (value.host !== LOOPBACK_HOST) return { valid: false, reason: 'non_loopback_host' };
  if (value.port < 1 || value.port > 65535) {
    return { valid: false, reason: 'port_out_of_range' };
  }
  if (value.pid <= 0) return { valid: false, reason: 'pid_dead' };
  if (options.pidAlive && !options.pidAlive(value.pid)) {
    return { valid: false, reason: 'pid_dead' };
  }

  return {
    valid: true,
    endpoint: {
      v: 1,
      name: value.name,
      host: LOOPBACK_HOST,
      port: value.port,
      pid: value.pid,
      startedAt: value.startedAt,
      instanceId: value.instanceId,
    },
  };
}

export function readEndpointFile(
  filePath: string,
  options: EndpointParseOptions = {},
): EndpointValidation {
  if (!existsSync(filePath)) return { valid: false, reason: 'missing_file' };

  let value: unknown;
  try {
    value = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return { valid: false, reason: 'parse_error' };
  }
  return parseEndpoint(value, options);
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

/**
 * 原子写端点文件：临时文件 + rename；只写地址元数据，绝不写 token。
 * 返回最终文件路径。
 */
export function writeEndpointFile(runtimeDir: string, endpoint: EndpointInfo): string {
  const validated = parseEndpoint(endpoint);
  if (!validated.valid) {
    throw new Error(`端点信息非法：${validated.reason}`);
  }

  mkdirSync(runtimeDir, { recursive: true });
  const targetPath = endpointPath(runtimeDir, endpoint.name);
  const tempPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
  const payload: EndpointInfo = {
    v: 1,
    name: endpoint.name,
    host: LOOPBACK_HOST,
    port: endpoint.port,
    pid: endpoint.pid,
    startedAt: endpoint.startedAt,
    instanceId: endpoint.instanceId,
  };

  try {
    writeFileSync(tempPath, `${JSON.stringify(payload)}\n`, 'utf8');
    renameSync(tempPath, targetPath);
    return targetPath;
  } catch (err) {
    try {
      rmSync(tempPath, { force: true });
    } catch {
      // 清理临时文件失败不掩盖原始写入错误
    }
    throw err;
  }
}

/** 仅当文件中的 instanceId 与本实例一致时删除，避免误删其他实例端点。 */
export function removeEndpointFile(
  runtimeDir: string,
  name: EndpointName,
  instanceId: string,
): boolean {
  const filePath = endpointPath(runtimeDir, name);
  const parsed = readEndpointFile(filePath);
  if (!parsed.valid || parsed.endpoint.name !== name) return false;
  if (parsed.endpoint.instanceId !== instanceId) return false;

  try {
    unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}
