import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  InstanceLock,
  InstanceLockError,
  instanceLockCleanupPath,
  instanceLockPath,
  type InstanceLockInfo,
} from '../../src/qq/lock.ts';

const NOW = 1_700_000_000_000;

let rootDir: string;
let stateDir: string;
let runtimeDir: string;

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'xds-lock-'));
  stateDir = join(rootDir, 'state');
  runtimeDir = join(rootDir, 'runtime');
  mkdirSync(stateDir, { recursive: true });
});

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

function readLock(): InstanceLockInfo {
  return JSON.parse(readFileSync(instanceLockPath(stateDir), 'utf8')) as InstanceLockInfo;
}

function writeEndpoint(pid: number, instanceId: string = 'endpoint-instance'): void {
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(
    join(runtimeDir, 'ds-memory.endpoint.json'),
    `${JSON.stringify({
      v: 1,
      name: 'ds-memory',
      host: '127.0.0.1',
      port: 1985,
      pid,
      startedAt: NOW,
      instanceId,
    })}\n`,
    'utf8',
  );
}

function lockError(fn: () => unknown): InstanceLockError {
  try {
    fn();
  } catch (err) {
    if (err instanceof InstanceLockError) return err;
    throw err;
  }
  throw new Error('预期抛出 InstanceLockError');
}

describe('InstanceLock', () => {
  it('首次获取写入 pid/instanceId/startedAt，释放后删除且重复释放无害', () => {
    const lock = new InstanceLock({
      stateDir,
      pid: 101,
      now: () => NOW,
      isPidAlive: () => true,
    });

    const info = lock.acquire();

    expect(info).toEqual({
      pid: 101,
      instanceId: lock.instanceId,
      startedAt: NOW,
    });
    expect(readLock()).toEqual(info);
    expect(readdirSync(stateDir)).toEqual(['ds-memory.lock']);
    expect(lock.release()).toBe(true);
    expect(existsSync(instanceLockPath(stateDir))).toBe(false);
    expect(readdirSync(stateDir)).toEqual([]);
    expect(lock.release()).toBe(false);
  });

  it('锁文件一出现就是完整 JSON，并发读取看不到空锁窗口', async () => {
    const path = instanceLockPath(stateDir);
    const reader = startLockReader(path, 300);
    await reader.ready;

    const lock = new InstanceLock({
      stateDir,
      instanceId: 'atomic',
      pid: 123,
      now: () => NOW,
      isPidAlive: () => true,
    });
    const end = Date.now() + 220;
    const pause = new Int32Array(new SharedArrayBuffer(4));
    while (Date.now() < end) {
      lock.acquire();
      Atomics.wait(pause, 0, 0, 2);
      lock.release();
      Atomics.wait(pause, 0, 0, 1);
    }

    const observed = await reader.result;
    expect(observed.bad).toBe(0);
    expect(observed.valid).toBeGreaterThan(0);
    expect(readdirSync(stateDir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('活 PID 的锁拒绝启动且绝不抢锁', () => {
    const first = new InstanceLock({
      stateDir,
      instanceId: 'instance-a',
      pid: 101,
      now: () => NOW,
      isPidAlive: (pid) => pid === 101,
    });
    const firstInfo = first.acquire();

    const second = new InstanceLock({
      stateDir,
      instanceId: 'instance-b',
      pid: 202,
      now: () => NOW,
      isPidAlive: (pid) => pid === 101,
    });
    const error = lockError(() => second.acquire());

    expect(error.code).toBe('lock_held');
    expect(readLock()).toEqual(firstInfo);
    expect(first.release()).toBe(true);
  });

  it('死 PID 的 stale 锁会被清理并重试一次', () => {
    writeFileSync(
      instanceLockPath(stateDir),
      `${JSON.stringify({ pid: 999, instanceId: 'dead', startedAt: NOW })}\n`,
      'utf8',
    );
    const lock = new InstanceLock({
      stateDir,
      instanceId: 'fresh',
      pid: 101,
      now: () => NOW,
      isPidAlive: () => false,
    });

    const info = lock.acquire();

    expect(info.instanceId).toBe('fresh');
    expect(readLock().instanceId).toBe('fresh');
  });

  it('损坏或字段非法的锁按 stale 清理', () => {
    const path = instanceLockPath(stateDir);
    writeFileSync(path, '{broken', 'utf8');

    const first = new InstanceLock({
      stateDir,
      instanceId: 'one',
      pid: 101,
      now: () => NOW,
      isPidAlive: () => false,
    });
    expect(first.acquire().instanceId).toBe('one');
    first.release();

    writeFileSync(
      path,
      `${JSON.stringify({ pid: 0, instanceId: '', startedAt: 'later' })}\n`,
      'utf8',
    );
    const second = new InstanceLock({
      stateDir,
      instanceId: 'two',
      pid: 101,
      now: () => NOW,
      isPidAlive: () => false,
    });
    expect(second.acquire().instanceId).toBe('two');
  });

  it('释放只删除 instanceId 与自身一致的锁', () => {
    const lock = new InstanceLock({
      stateDir,
      instanceId: 'mine',
      pid: 101,
      now: () => NOW,
      isPidAlive: () => true,
    });
    lock.acquire();
    writeFileSync(
      instanceLockPath(stateDir),
      `${JSON.stringify({
        pid: 101,
        instanceId: 'other',
        startedAt: NOW,
      })}\n`,
      'utf8',
    );

    expect(lock.release()).toBe(false);
    expect(existsSync(instanceLockPath(stateDir))).toBe(true);
    expect(readLock().instanceId).toBe('other');
    expect(readdirSync(stateDir)).toEqual(['ds-memory.lock']);
  });

  it('release 无法获取 live cleanup lease 时仍移除自己的主锁', () => {
    const lock = new InstanceLock({
      stateDir,
      instanceId: 'mine',
      pid: 101,
      now: () => NOW,
      isPidAlive: (pid) => pid === 909,
      cleanupLeaseRetryDelayMs: 1,
      cleanupLeaseRetryLimit: 2,
    });
    lock.acquire();
    writeFileSync(
      instanceLockCleanupPath(stateDir),
      `${JSON.stringify({ pid: 909, instanceId: 'cleaner', startedAt: NOW })}\n`,
      'utf8',
    );

    expect(lock.release()).toBe(false);

    expect(existsSync(instanceLockPath(stateDir))).toBe(false);
    expect(readdirSync(stateDir)).toEqual(['ds-memory.lock.cleanup']);
  });

  it('release 读取 release 文件失败时保留 artifact 且不还原活主锁', () => {
    const mainPath = instanceLockPath(stateDir);
    let failReleaseRead = false;
    const lock = new InstanceLock({
      stateDir,
      instanceId: 'mine',
      pid: 101,
      now: () => NOW,
      isPidAlive: () => true,
      testHooks: {
        readFileText: (path) => {
          if (failReleaseRead && path.endsWith('.release')) {
            const error = new Error('EACCES');
            (error as NodeJS.ErrnoException).code = 'EACCES';
            throw error;
          }
          return readFileSync(path, 'utf8');
        },
      },
    });
    lock.acquire();
    failReleaseRead = true;

    expect(lock.release()).toBe(false);

    expect(existsSync(mainPath)).toBe(false);
    const entries = readdirSync(stateDir);
    const releaseArtifact = entries.find((name) => name.endsWith('.release'));
    expect(releaseArtifact).toBeDefined();
    expect(
      JSON.parse(readFileSync(join(stateDir, releaseArtifact!), 'utf8')),
    ).toMatchObject({ instanceId: 'mine' });
    expect(entries).toHaveLength(1);
  });

  it('release 读取失败时若主锁已被其他实例替换则还原对方锁', () => {
    const mainPath = instanceLockPath(stateDir);
    const replacementPath = join(stateDir, 'replacement');
    const occupied = `${JSON.stringify({
      pid: 777,
      instanceId: 'occupied',
      startedAt: NOW,
    })}\n`;
    let failReleaseRead = false;
    const lock = new InstanceLock({
      stateDir,
      instanceId: 'mine',
      pid: 101,
      now: () => NOW,
      isPidAlive: (pid) => pid === 777,
      testHooks: {
        readFileText: (path) => {
          if (failReleaseRead && path.endsWith('.release')) {
            const error = new Error('EACCES');
            (error as NodeJS.ErrnoException).code = 'EACCES';
            throw error;
          }
          return readFileSync(path, 'utf8');
        },
      },
    });
    lock.acquire();
    writeFileSync(replacementPath, occupied, 'utf8');
    const ownInode = statSync(mainPath).ino;
    const replacementInode = statSync(replacementPath).ino;
    expect(replacementInode).not.toBe(ownInode);
    unlinkSync(mainPath);
    renameSync(replacementPath, mainPath);
    failReleaseRead = true;

    expect(lock.release()).toBe(false);

    expect(readFileSync(mainPath, 'utf8')).toBe(occupied);
    expect(readdirSync(stateDir)).toEqual(['ds-memory.lock']);
  });

  it('两个实例并发获取只有一个成功', () => {
    const first = new InstanceLock({
      stateDir,
      instanceId: 'a',
      pid: 101,
      now: () => NOW,
      isPidAlive: (pid) => pid === 101,
    });
    const second = new InstanceLock({
      stateDir,
      instanceId: 'b',
      pid: 101,
      now: () => NOW,
      isPidAlive: (pid) => pid === 101,
    });

    const outcomes = [first, second].map((lock) => {
      try {
        return lock.acquire();
      } catch (err) {
        return err;
      }
    });

    const winners = outcomes.filter(
      (value): value is InstanceLockInfo =>
        typeof value === 'object' && value !== null && 'instanceId' in value,
    );
    expect(winners).toHaveLength(1);
    expect(outcomes.filter((value) => value instanceof InstanceLockError)).toHaveLength(1);
    expect(outcomes[1]).toBeInstanceOf(InstanceLockError);
    first.release();
  });

  it('stale 清理竞态：B 误 rename A 的新锁时检测原文不一致、还原并拒绝', () => {
    writeFileSync(
      instanceLockPath(stateDir),
      `${JSON.stringify({ pid: 999, instanceId: 'old-stale', startedAt: NOW })}\n`,
      'utf8',
    );
    const isPidAlive = (pid: number): boolean => pid === 111;
    const lockA = new InstanceLock({
      stateDir,
      instanceId: 'instance-a',
      pid: 111,
      now: () => NOW,
      isPidAlive,
    });
    let hookRuns = 0;
    const lockB = new InstanceLock({
      stateDir,
      instanceId: 'instance-b',
      pid: 222,
      now: () => NOW,
      isPidAlive,
      testHooks: {
        afterStaleRead: () => {
          hookRuns += 1;
          lockA.acquire();
        },
      },
    });

    const error = lockError(() => lockB.acquire());

    expect(hookRuns).toBe(1);
    expect(error.code).toBe('lock_held');
    expect(readLock().instanceId).toBe('instance-a');
    expect(readdirSync(stateDir)).toEqual(['ds-memory.lock']);
    expect(lockB.release()).toBe(false);
    expect(lockA.release()).toBe(true);
    expect(readdirSync(stateDir)).toEqual([]);
  });

  it('三实例 cleanup lease：仅一个成功，失败者不移动或删除赢家主锁', () => {
    writeFileSync(
      instanceLockPath(stateDir),
      `${JSON.stringify({ pid: 999, instanceId: 'old-stale', startedAt: NOW })}\n`,
      'utf8',
    );
    const livePids = new Set([111, 222, 333]);
    const isPidAlive = (pid: number): boolean => livePids.has(pid);
    const outcomes: Array<InstanceLockInfo | InstanceLockError> = [];
    let staleReads = 0;
    let lockB: InstanceLock;
    let lockC: InstanceLock;

    const run = (lock: InstanceLock): InstanceLockInfo | InstanceLockError => {
      try {
        return lock.acquire();
      } catch (err) {
        if (err instanceof InstanceLockError) return err;
        throw err;
      }
    };

    const lockA = new InstanceLock({
      stateDir,
      instanceId: 'instance-a',
      pid: 111,
      now: () => NOW,
      isPidAlive,
      testHooks: {
        afterStaleRead: () => {
          staleReads += 1;
          outcomes.push(run(lockB));
        },
      },
    });
    lockB = new InstanceLock({
      stateDir,
      instanceId: 'instance-b',
      pid: 222,
      now: () => NOW,
      isPidAlive,
      testHooks: {
        afterStaleRead: () => {
          staleReads += 1;
          outcomes.push(run(lockC));
        },
      },
    });
    lockC = new InstanceLock({
      stateDir,
      instanceId: 'instance-c',
      pid: 333,
      now: () => NOW,
      isPidAlive,
      testHooks: {
        afterStaleRead: () => {
          staleReads += 1;
        },
      },
    });

    outcomes.push(run(lockA));

    const winners = outcomes.filter(
      (value): value is InstanceLockInfo =>
        typeof value === 'object' && value !== null && 'instanceId' in value,
    );
    const failures = outcomes.filter(
      (value): value is InstanceLockError => value instanceof InstanceLockError,
    );
    expect(staleReads).toBe(3);
    expect(winners).toHaveLength(1);
    expect(winners[0]?.instanceId).toBe('instance-c');
    expect(failures).toHaveLength(2);
    expect(failures.map((error) => error.code)).toEqual(['lock_held', 'lock_held']);
    expect(readLock().instanceId).toBe('instance-c');
    expect(readdirSync(stateDir)).toEqual(['ds-memory.lock']);
    expect(lockA.release()).toBe(false);
    expect(lockB.release()).toBe(false);
    expect(lockC.release()).toBe(true);
    expect(readdirSync(stateDir)).toEqual([]);
  });

  it('cleanup lease 被活 PID 持有时有界等待后拒绝，且不清理主锁或 lease', () => {
    const stale = `${JSON.stringify({ pid: 999, instanceId: 'dead', startedAt: NOW })}\n`;
    const cleanupLease = {
      pid: 909,
      instanceId: 'live-cleaner',
      startedAt: NOW,
    };
    writeFileSync(instanceLockPath(stateDir), stale, 'utf8');
    writeFileSync(
      instanceLockCleanupPath(stateDir),
      `${JSON.stringify(cleanupLease)}\n`,
      'utf8',
    );
    const lock = new InstanceLock({
      stateDir,
      instanceId: 'mine',
      pid: 101,
      now: () => NOW,
      isPidAlive: (pid) => pid === 909,
      cleanupLeaseRetryDelayMs: 1,
      cleanupLeaseRetryLimit: 3,
    });

    const error = lockError(() => lock.acquire());

    expect(error.code).toBe('lock_held');
    expect(readFileSync(instanceLockPath(stateDir), 'utf8')).toBe(stale);
    expect(JSON.parse(readFileSync(instanceLockCleanupPath(stateDir), 'utf8'))).toEqual(
      cleanupLease,
    );
    expect(readdirSync(stateDir).sort()).toEqual([
      'ds-memory.lock',
      'ds-memory.lock.cleanup',
    ]);
  });

  it('死 PID 或损坏的 cleanup lease 在原文核对后清理并继续获取主锁', () => {
    const stale = `${JSON.stringify({ pid: 999, instanceId: 'dead', startedAt: NOW })}\n`;
    const leaseTexts = [
      `${JSON.stringify({ pid: 999, instanceId: 'dead-cleaner', startedAt: NOW })}\n`,
      '{broken-lease',
    ];

    for (const leaseText of leaseTexts) {
      writeFileSync(instanceLockPath(stateDir), stale, 'utf8');
      writeFileSync(instanceLockCleanupPath(stateDir), leaseText, 'utf8');
      const lock = new InstanceLock({
        stateDir,
        instanceId: 'fresh',
        pid: 101,
        now: () => NOW,
        isPidAlive: () => false,
      });

      expect(lock.acquire().instanceId).toBe('fresh');
      expect(readLock().instanceId).toBe('fresh');
      expect(readdirSync(stateDir)).toEqual(['ds-memory.lock']);
      expect(lock.release()).toBe(true);
      expect(readdirSync(stateDir)).toEqual([]);
    }
  });

  it('还原 link 命中 EEXIST 时保留 stale artifact 且不覆盖现有锁', () => {
    const stale = `${JSON.stringify({ pid: 999, instanceId: 'dead', startedAt: NOW })}\n`;
    const occupied = `${JSON.stringify({ pid: 777, instanceId: 'occupied', startedAt: NOW })}\n`;
    const mainPath = instanceLockPath(stateDir);
    writeFileSync(mainPath, stale, 'utf8');
    let artifactPath = '';
    const lock = new InstanceLock({
      stateDir,
      instanceId: 'mine',
      pid: 101,
      now: () => NOW,
      isPidAlive: (pid) => pid === 777,
      testHooks: {
        afterCleanupRename: (artifact, target) => {
          if (target !== mainPath) return;
          artifactPath = artifact;
          writeFileSync(artifact, '{replaced-stale}', 'utf8');
          writeFileSync(target, occupied, 'utf8');
        },
      },
    });

    const error = lockError(() => lock.acquire());

    expect(error.code).toBe('lock_held');
    expect(readFileSync(mainPath, 'utf8')).toBe(occupied);
    expect(artifactPath).not.toBe('');
    expect(existsSync(artifactPath)).toBe(true);
    expect(readFileSync(artifactPath, 'utf8')).toBe('{replaced-stale}');
    expect(readdirSync(stateDir).sort()).toEqual(
      ['ds-memory.lock', artifactPath.slice(stateDir.length + 1)].sort(),
    );
  });

  it('release 发现其他实例锁且还原 EEXIST 时保留 release artifact', () => {
    const occupied = `${JSON.stringify({ pid: 777, instanceId: 'occupied', startedAt: NOW })}\n`;
    const mainPath = instanceLockPath(stateDir);
    let releaseArtifact = '';
    const lock = new InstanceLock({
      stateDir,
      instanceId: 'mine',
      pid: 101,
      now: () => NOW,
      isPidAlive: (pid) => pid === 777,
      testHooks: {
        readFileText: (path) => {
          if (path.endsWith('.release')) {
            releaseArtifact = path;
            writeFileSync(mainPath, occupied, 'utf8');
            return occupied;
          }
          return readFileSync(path, 'utf8');
        },
      },
    });
    lock.acquire();

    expect(lock.release()).toBe(false);
    expect(readFileSync(mainPath, 'utf8')).toBe(occupied);
    expect(releaseArtifact).not.toBe('');
    expect(existsSync(releaseArtifact)).toBe(true);
    expect(readdirSync(stateDir).sort()).toEqual(
      ['ds-memory.lock', releaseArtifact.slice(stateDir.length + 1)].sort(),
    );
  });

  it('读取锁失败（EACCES）时 fail closed，且不删除存活锁', () => {
    const live = { pid: 101, instanceId: 'live-instance', startedAt: NOW };
    writeFileSync(
      instanceLockPath(stateDir),
      `${JSON.stringify(live)}\n`,
      'utf8',
    );
    let reads = 0;
    const lock = new InstanceLock({
      stateDir,
      instanceId: 'mine',
      pid: 202,
      now: () => NOW,
      isPidAlive: () => true,
      testHooks: {
        readFileText: () => {
          reads += 1;
          const error = new Error('EACCES');
          (error as NodeJS.ErrnoException).code = 'EACCES';
          throw error;
        },
      },
    });

    const error = lockError(() => lock.acquire());

    expect(error.code).toBe('lock_write_failed');
    expect(reads).toBe(1);
    expect(readLock()).toEqual(live);
  });

  it('原子发布回读 instanceId 不一致时拒绝且不删除其他实例锁', () => {
    const other = { pid: 303, instanceId: 'other-instance', startedAt: NOW };
    const lock = new InstanceLock({
      stateDir,
      instanceId: 'mine',
      pid: 202,
      now: () => NOW,
      isPidAlive: () => true,
      testHooks: {
        afterPublish: () => {
          const path = instanceLockPath(stateDir);
          unlinkSync(path);
          writeFileSync(path, `${JSON.stringify(other)}\n`, 'utf8');
        },
      },
    });

    const error = lockError(() => lock.acquire());

    expect(error.code).toBe('lock_held');
    expect(readLock()).toEqual(other);
    expect(readdirSync(stateDir)).toEqual(['ds-memory.lock']);
    expect(lock.release()).toBe(false);
  });

  it('原子发布回读失败时清理刚发布的自身主锁', () => {
    const mainPath = instanceLockPath(stateDir);
    const lock = new InstanceLock({
      stateDir,
      instanceId: 'mine',
      pid: 202,
      now: () => NOW,
      isPidAlive: () => true,
      testHooks: {
        readFileText: (path) => {
          if (path === mainPath) {
            const error = new Error('EACCES');
            (error as NodeJS.ErrnoException).code = 'EACCES';
            throw error;
          }
          return readFileSync(path, 'utf8');
        },
      },
    });

    const error = lockError(() => lock.acquire());

    expect(error.code).toBe('lock_write_failed');
    expect(existsSync(mainPath)).toBe(false);
    expect(readdirSync(stateDir)).toEqual([]);
    expect(lock.release()).toBe(false);
  });

  it('存活 ds-memory 端点拒绝启动并释放刚获取的锁', () => {
    writeEndpoint(555, 'live-endpoint');
    const lock = new InstanceLock({
      stateDir,
      runtimeDir,
      instanceId: 'mine',
      pid: 101,
      now: () => NOW,
      isPidAlive: (pid) => pid === 555,
    });

    const error = lockError(() => lock.acquire());

    expect(error.code).toBe('endpoint_held');
    expect(existsSync(instanceLockPath(stateDir))).toBe(false);
  });

  it('死 PID 或损坏的 ds-memory 端点允许启动', () => {
    writeEndpoint(555, 'stale-endpoint');
    const first = new InstanceLock({
      stateDir,
      runtimeDir,
      instanceId: 'mine',
      pid: 101,
      now: () => NOW,
      isPidAlive: () => false,
    });
    expect(first.acquire().instanceId).toBe('mine');
    first.release();

    writeFileSync(join(runtimeDir, 'ds-memory.endpoint.json'), '{broken', 'utf8');
    const second = new InstanceLock({
      stateDir,
      runtimeDir,
      instanceId: 'other',
      pid: 101,
      now: () => NOW,
      isPidAlive: () => false,
    });
    expect(second.acquire().instanceId).toBe('other');
    second.release();
  });
});

function startLockReader(
  lockPath: string,
  durationMs: number,
): { ready: Promise<void>; result: Promise<{ valid: number; bad: number }> } {
  const script = `
const fs = require('node:fs');
const path = process.argv[1];
const end = Date.now() + Number(process.argv[2]);
let valid = 0;
let bad = 0;
process.stdout.write('ready\\n');
while (Date.now() < end) {
  try {
    const text = fs.readFileSync(path, 'utf8');
    if (text.trim().length === 0) {
      bad += 1;
      continue;
    }
    const value = JSON.parse(text);
    if (
      !value ||
      typeof value.pid !== 'number' ||
      typeof value.instanceId !== 'string' ||
      typeof value.startedAt !== 'number'
    ) {
      bad += 1;
    } else {
      valid += 1;
    }
  } catch (err) {
    if (!err || err.code !== 'ENOENT') bad += 1;
  }
}
process.stdout.write(JSON.stringify({ valid, bad }));
`;
  const child = spawn(
    process.execPath,
    ['-e', script, lockPath, String(durationMs)],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );

  let stdout = '';
  let resolveReady: (() => void) | null = null;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
    if (stdout.includes('ready\n')) resolveReady?.();
  });

  const result = new Promise<{ valid: number; bad: number }>((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`锁读取子进程退出码 ${code}`));
        return;
      }
      const lines = stdout.trim().split(/\r?\n/);
      try {
        resolve(JSON.parse(lines.at(-1) ?? '') as { valid: number; bad: number });
      } catch {
        reject(new Error('锁读取子进程输出不是 JSON'));
      }
    });
  });

  return { ready, result };
}
