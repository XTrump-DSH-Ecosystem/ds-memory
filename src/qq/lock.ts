import { randomUUID } from 'node:crypto';
import {
  closeSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { endpointPath, isProcessAlive, readEndpointFile } from './endpoint.ts';

export const INSTANCE_LOCK_FILENAME = 'ds-memory.lock';
export const INSTANCE_LOCK_CLEANUP_SUFFIX = '.cleanup';

export type InstanceLockErrorCode =
  | 'lock_held'
  | 'endpoint_held'
  | 'lock_write_failed';

/** 固定文案错误；不携带锁文件路径或进程命令行。 */
export class InstanceLockError extends Error {
  readonly code: InstanceLockErrorCode;

  constructor(code: InstanceLockErrorCode, message: string) {
    super(message);
    this.name = 'InstanceLockError';
    this.code = code;
  }
}

export interface InstanceLockInfo {
  pid: number;
  instanceId: string;
  startedAt: number;
}

interface FileIdentity {
  dev: number;
  ino: number;
}

/** 仅测试注入；生产路径使用默认 fs 读取。 */
export interface InstanceLockTestHooks {
  /** stale 原文已读取、PID 判定完成后、rename 之前调用。 */
  afterStaleRead?: () => void;
  /** 原子 link 发布完成、回读校验之前调用。 */
  afterPublish?: () => void;
  /** cleanup 临时文件已 rename、原文校验之前调用。 */
  afterCleanupRename?: (artifactPath: string, targetPath: string) => void;
  /** 覆盖锁文件读取；用于注入 EACCES/EPERM 等故障。 */
  readFileText?: (path: string) => string;
}

export interface InstanceLockOptions {
  stateDir: string;
  /** 传入时同时检查 ds-memory 端点文件是否仍由存活进程持有。 */
  runtimeDir?: string;
  instanceId?: string;
  pid?: number;
  now?: () => number;
  isPidAlive?: (pid: number) => boolean;
  /** cleanup lease 冲突时每次重试等待的毫秒数。 */
  cleanupLeaseRetryDelayMs?: number;
  /** cleanup lease 冲突时的最大重试次数。 */
  cleanupLeaseRetryLimit?: number;
  testHooks?: InstanceLockTestHooks;
}

export function instanceLockPath(stateDir: string): string {
  return join(stateDir, INSTANCE_LOCK_FILENAME);
}

export function instanceLockCleanupPath(stateDir: string): string {
  return `${instanceLockPath(stateDir)}${INSTANCE_LOCK_CLEANUP_SUFFIX}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseLockInfo(text: string): InstanceLockInfo | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  if (typeof value.pid !== 'number' || !Number.isInteger(value.pid) || value.pid <= 0) {
    return null;
  }
  if (typeof value.instanceId !== 'string' || value.instanceId.length === 0) {
    return null;
  }
  if (typeof value.startedAt !== 'number' || !Number.isFinite(value.startedAt)) {
    return null;
  }
  return {
    pid: value.pid,
    instanceId: value.instanceId,
    startedAt: value.startedAt,
  };
}

/**
 * 单实例锁（P2 T6b，§4.5）：
 * - 锁文件 `<stateDir>/ds-memory.lock`，内容 `{pid, instanceId, startedAt}`；
 * - 原子 `wx` 创建；已存在时只在确认 PID 不存在/内容损坏时清理 stale 后重试一次；
 * - 活 PID 一律拒绝，绝不抢锁；
 * - 释放只删除 instanceId 与自身一致的锁；
 * - 可选检查 `runtimeDir/ds-memory.endpoint.json` 的存活 PID。
 */
export class InstanceLock {
  readonly path: string;
  readonly instanceId: string;

  private readonly runtimeDir: string | undefined;
  private readonly pid: number;
  private readonly now: () => number;
  private readonly isPidAlive: (pid: number) => boolean;
  private readonly cleanupLeaseRetryDelayMs: number;
  private readonly cleanupLeaseRetryLimit: number;
  private readonly readFileText: (path: string) => string;
  private readonly testHooks: InstanceLockTestHooks;

  private acquired = false;
  private info: InstanceLockInfo | null = null;
  private mainIdentity: FileIdentity | null = null;

  constructor(options: InstanceLockOptions) {
    this.path = instanceLockPath(options.stateDir);
    this.runtimeDir = options.runtimeDir;
    this.instanceId = options.instanceId ?? randomUUID();
    this.pid = options.pid ?? process.pid;
    this.now = options.now ?? Date.now;
    this.isPidAlive = options.isPidAlive ?? isProcessAlive;
    this.cleanupLeaseRetryDelayMs = options.cleanupLeaseRetryDelayMs ?? 10;
    this.cleanupLeaseRetryLimit = options.cleanupLeaseRetryLimit ?? 20;
    this.readFileText =
      options.testHooks?.readFileText ?? ((path) => readFileSync(path, 'utf8'));
    this.testHooks = options.testHooks ?? {};
  }

  get lockInfo(): InstanceLockInfo | null {
    return this.info ? { ...this.info } : null;
  }

  acquire(): InstanceLockInfo {
    if (this.acquired && this.info) return { ...this.info };

    try {
      mkdirSync(dirname(this.path), { recursive: true });
    } catch {
      throw new InstanceLockError('lock_write_failed', '单实例锁写入失败');
    }
    const info: InstanceLockInfo = {
      pid: this.pid,
      instanceId: this.instanceId,
      startedAt: this.now(),
    };
    const payload = `${JSON.stringify(info)}\n`;

    if (!this.publishExclusive(this.path, payload, true)) {
      let snapshot = this.readSnapshot(this.path);
      if (snapshot.kind === 'text') {
        const existing = parseLockInfo(snapshot.text);
        if (existing && this.isPidAlive(existing.pid)) {
          throw new InstanceLockError('lock_held', '已有 ds-memory 实例在运行');
        }
        this.testHooks.afterStaleRead?.();
      }

      this.cleanupThenPublish(payload);
    }

    this.acquired = true;
    this.info = info;
    this.mainIdentity = this.fileIdentity(this.path);

    if (this.runtimeDir !== undefined && this.liveEndpointExists()) {
      this.release();
      throw new InstanceLockError(
        'endpoint_held',
        'ds-memory 端点仍由存活进程持有',
      );
    }

    return { ...info };
  }

  /** 幂等；只删除属于本实例的锁，不抛错。 */
  release(): boolean {
    if (!this.acquired) return false;
    this.acquired = false;
    this.info = null;
    const identity = this.mainIdentity;
    this.mainIdentity = null;

    let leasePayload: string;
    try {
      leasePayload = this.acquireCleanupLease();
    } catch {
      // lease 不可得时仍尽力移除自己的主锁，避免返回失败却留下活锁。
      this.removeMainIfOwned(identity);
      return false;
    }

    try {
      return this.removeMainIfOwned(identity);
    } finally {
      this.releaseCleanupLease(leasePayload);
    }
  }

  /**
   * 主锁已存在且不是活实例时，先持有 cleanup lease，再重新检查并清理。
   * lease 把「读取 stale、删除 stale、发布新锁」串行化，避免多个实例互相搬走新锁。
   */
  private cleanupThenPublish(payload: string): void {
    const leasePayload = this.acquireCleanupLease();
    let leaseHeld = true;
    try {
      const snapshot = this.readSnapshot(this.path);
      if (snapshot.kind === 'missing') {
        // 主锁在观察后消失：先归还 lease，再按规范只重试一次发布。
        this.releaseCleanupLease(leasePayload);
        leaseHeld = false;
        if (!this.publishExclusive(this.path, payload, true)) {
          throw new InstanceLockError('lock_held', '已有 ds-memory 实例在运行');
        }
        return;
      }

      const current = parseLockInfo(snapshot.text);
      if (current && this.isPidAlive(current.pid)) {
        throw new InstanceLockError('lock_held', '已有 ds-memory 实例在运行');
      }

      this.discardExact(this.path, snapshot.text);
      if (!this.publishExclusive(this.path, payload, true)) {
        throw new InstanceLockError('lock_held', '已有 ds-memory 实例在运行');
      }
    } finally {
      if (leaseHeld) this.releaseCleanupLease(leasePayload);
    }
  }

  /**
   * 原子发布：完整临时文件 + linkSync 到目标路径。
   * 返回 false 仅表示目标已存在（EEXIST）；其他错误转为固定错误码。
   */
  private publishExclusive(
    targetPath: string,
    payload: string,
    isMainLock: boolean = false,
  ): boolean {
    const tempPath = `${targetPath}.${this.pid}.${randomUUID()}.tmp`;
    let fd: number | null = null;
    let tempCreated = false;
    let linked = false;
    let readFailed = false;

    try {
      fd = openSync(tempPath, 'wx');
      tempCreated = true;
      writeFileSync(fd, payload, 'utf8');
      closeSync(fd);
      fd = null;

      try {
        // 硬链接把完整临时文件原子发布为锁文件；目标已存在时返回 EEXIST。
        linkSync(tempPath, targetPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
        throw err;
      }
      linked = true;

      if (isMainLock) this.testHooks.afterPublish?.();

      let publishedText: string;
      try {
        publishedText = this.readFileText(targetPath);
      } catch {
        readFailed = true;
        throw new InstanceLockError('lock_write_failed', '单实例锁读取失败');
      }
      const published = parseLockInfo(publishedText);
      if (!published || published.instanceId !== this.instanceId) {
        throw new InstanceLockError('lock_held', '锁发布校验失败');
      }
      return true;
    } catch (err) {
      if (readFailed && linked && this.isSameFile(tempPath, targetPath)) {
        try {
          unlinkSync(targetPath);
        } catch {
          // 无法确认清理时保留现场；下次启动会按 stale 流程处理。
        }
      }
      if (err instanceof InstanceLockError) throw err;
      throw new InstanceLockError('lock_write_failed', '单实例锁写入失败');
    } finally {
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          // 仅清理失败，不覆盖原始写入错误
        }
      }
      if (tempCreated) {
        try {
          unlinkSync(tempPath);
        } catch {
          // 已确认发布后，临时硬链接清理失败不影响主锁。
        }
      }
    }
  }

  private isSameFile(leftPath: string, rightPath: string): boolean {
    const left = this.fileIdentity(leftPath);
    const right = this.fileIdentity(rightPath);
    return (
      left !== null &&
      right !== null &&
      left.dev === right.dev &&
      left.ino === right.ino
    );
  }

  private fileIdentity(filePath: string): FileIdentity | null {
    try {
      const stat = statSync(filePath);
      return { dev: stat.dev, ino: stat.ino };
    } catch {
      return null;
    }
  }

  private readSnapshot(
    filePath: string,
  ): { kind: 'missing' } | { kind: 'text'; text: string } {
    try {
      return { kind: 'text', text: this.readFileText(filePath) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { kind: 'missing' };
      }
      throw new InstanceLockError('lock_write_failed', '单实例锁写入失败');
    }
  }

  /**
   * 获取 cleanup lease。活 PID 持有者会让本实例有界等待并拒绝；
   * 不存在、死 PID 或损坏的 lease 只有在原文完全一致时才会被清理。
   */
  private acquireCleanupLease(): string {
    const leasePath = `${this.path}${INSTANCE_LOCK_CLEANUP_SUFFIX}`;
    const leaseInfo: InstanceLockInfo = {
      pid: this.pid,
      instanceId: this.instanceId,
      startedAt: this.now(),
    };
    const leasePayload = `${JSON.stringify(leaseInfo)}\n`;

    for (let attempt = 0; attempt <= this.cleanupLeaseRetryLimit; attempt += 1) {
      if (this.publishExclusive(leasePath, leasePayload)) return leasePayload;

      const snapshot = this.readSnapshot(leasePath);
      if (snapshot.kind === 'missing') continue;

      const current = parseLockInfo(snapshot.text);
      if (current && this.isPidAlive(current.pid)) {
        if (attempt >= this.cleanupLeaseRetryLimit) break;
        this.waitForCleanupLeaseRetry();
        continue;
      }

      this.discardExact(leasePath, snapshot.text);
    }

    throw new InstanceLockError('lock_held', 'cleanup lease 正被其他实例持有');
  }

  private waitForCleanupLeaseRetry(): void {
    if (this.cleanupLeaseRetryDelayMs <= 0) return;
    Atomics.wait(
      new Int32Array(new SharedArrayBuffer(4)),
      0,
      0,
      this.cleanupLeaseRetryDelayMs,
    );
  }

  private releaseCleanupLease(leasePayload: string): boolean {
    const leasePath = `${this.path}${INSTANCE_LOCK_CLEANUP_SUFFIX}`;
    try {
      this.discardExact(leasePath, leasePayload);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 先把目标文件改名到本实例独占的 artifact，再核对内容是否仍是预期原文。
   * 内容不一致时尽力还原；link 还原遇到 EEXIST 时保留 artifact，绝不覆盖现有锁。
   */
  private discardExact(filePath: string, expectedText: string): void {
    const artifactPath = `${filePath}.${this.pid}.${randomUUID()}.stale`;
    try {
      renameSync(filePath, artifactPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw new InstanceLockError('lock_write_failed', '单实例锁写入失败');
    }

    try {
      this.testHooks.afterCleanupRename?.(artifactPath, filePath);
    } catch {
      this.restoreArtifact(artifactPath, filePath);
      throw new InstanceLockError('lock_write_failed', 'stale 锁校验失败');
    }

    let actualText: string;
    try {
      actualText = this.readFileText(artifactPath);
    } catch {
      this.restoreArtifact(artifactPath, filePath);
      throw new InstanceLockError('lock_write_failed', 'stale 锁校验失败');
    }

    if (actualText !== expectedText) {
      this.restoreArtifact(artifactPath, filePath);
      throw new InstanceLockError('lock_held', 'stale 锁已被其他实例替换');
    }

    try {
      unlinkSync(artifactPath);
    } catch {
      throw new InstanceLockError('lock_write_failed', 'stale 锁清理失败');
    }
  }

  /** 仅当主锁 instanceId 与本实例一致时删除；失败时保留现场。 */
  private removeMainIfOwned(identity: FileIdentity | null): boolean {
    const releasePath = `${this.path}.${this.pid}.${randomUUID()}.release`;
    try {
      renameSync(this.path, releasePath);
    } catch {
      return false;
    }

    let current: InstanceLockInfo | null = null;
    try {
      current = parseLockInfo(this.readFileText(releasePath));
    } catch {
      // 读取失败时用发布时记录的 inode 判断归属：自己的锁不还原，
      // 已被其他实例替换的锁必须还原，绝不能移动对方的主锁。
      if (!this.matchesIdentity(releasePath, identity)) {
        this.tryRestoreArtifact(releasePath, this.path);
      }
      return false;
    }

    if (!current || current.instanceId !== this.instanceId) {
      this.tryRestoreArtifact(releasePath, this.path);
      return false;
    }

    try {
      unlinkSync(releasePath);
      return true;
    } catch {
      return false;
    }
  }

  private matchesIdentity(filePath: string, identity: FileIdentity | null): boolean {
    if (identity === null) return false;
    const current = this.fileIdentity(filePath);
    return (
      current !== null &&
      current.dev === identity.dev &&
      current.ino === identity.ino
    );
  }

  private tryRestoreArtifact(artifactPath: string, targetPath: string): void {
    try {
      this.restoreArtifact(artifactPath, targetPath);
    } catch {
      // 保留 artifact，让后续诊断能看到未还原的锁内容。
    }
  }

  private restoreArtifact(artifactPath: string, targetPath: string): void {
    try {
      linkSync(artifactPath, targetPath);
    } catch (err) {
      // 目标已被其他实例占用：绝不覆盖，保留 artifact 供诊断。
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return;
      throw new InstanceLockError('lock_write_failed', 'stale 锁还原失败');
    }

    try {
      unlinkSync(artifactPath);
    } catch {
      // 主锁已还原，多余硬链接可在下次检查时处理。
    }
  }

  private liveEndpointExists(): boolean {
    const parsed = readEndpointFile(endpointPath(this.runtimeDir!, 'ds-memory'), {
      expectedName: 'ds-memory',
      pidAlive: this.isPidAlive,
    });
    return parsed.valid;
  }
}
