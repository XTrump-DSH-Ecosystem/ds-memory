import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  CODE_SESSION_WORKSPACE_MAX_CHARS,
  isSafeSessionId,
  isSafeSessionText,
  type CodeBridgeRepo,
  type CodeBridgeTask,
  type CodeTaskStatus,
} from './bridge-client.ts';

export type CodeTaskNotificationStatus = 'pending' | 'sent' | 'ambiguous';

export interface CodeTaskRecord {
  requestId: string;
  taskId: string;
  repo: CodeBridgeRepo;
  status: CodeTaskStatus;
  taskLength: number;
  submittedAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  worktree: string | null;
  changedFiles: string[];
  diffStat: string | null;
  summary: string | null;
  error: string | null;
  cancelRequestedAt: number | null;
  notificationStatus: CodeTaskNotificationStatus;
  notifiedAt: number | null;
  sessionId?: string | null;
  workspace?: string | null;
  mode?: CodeBridgeTask['mode'];
}

interface CodeTasksFile {
  v: 1;
  tasks: CodeTaskRecord[];
}

export interface CodeTaskStoreOptions {
  stateDir: string;
  onWarn?: (message: string) => void;
}

export function codeTasksStatePath(stateDir: string): string {
  return join(stateDir, 'code-tasks.json');
}

const REPOS: ReadonlySet<string> = new Set([
  'ds-memory',
  'martilyric',
  'qq-gateway',
  'xtds',
  'xtds-assistant-dsh',
  'dsh-session',
]);
const STATUSES: ReadonlySet<string> = new Set([
  'queued',
  'running',
  'succeeded',
  'failed',
  'canceled',
  'timed_out',
]);
const NOTIFICATIONS: ReadonlySet<string> = new Set(['pending', 'sent', 'ambiguous']);
const MODES: ReadonlySet<string> = new Set(['worktree', 'resume', 'workspace']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNullableTimestamp(value: unknown): value is number | null {
  return value === null || isTimestamp(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

interface OptionalRecordFields {
  sessionId?: string | null;
  workspace?: string | null;
  mode?: CodeBridgeTask['mode'];
}

function parseOptionalFields(value: Record<string, unknown>): OptionalRecordFields | null {
  const fields: OptionalRecordFields = {};

  if (value.sessionId !== undefined) {
    if (value.sessionId === null) {
      fields.sessionId = null;
    } else if (
      typeof value.sessionId === 'string' &&
      isSafeSessionId(value.sessionId)
    ) {
      fields.sessionId = value.sessionId;
    } else {
      return null;
    }
  }

  if (value.workspace !== undefined) {
    if (value.workspace === null) {
      fields.workspace = null;
    } else if (
      typeof value.workspace === 'string' &&
      isSafeSessionText(value.workspace, CODE_SESSION_WORKSPACE_MAX_CHARS)
    ) {
      fields.workspace = value.workspace;
    } else {
      return null;
    }
  }

  if (value.mode !== undefined) {
    if (value.mode === null) {
      fields.mode = null;
    } else if (typeof value.mode === 'string' && MODES.has(value.mode)) {
      fields.mode = value.mode as CodeBridgeTask['mode'];
    } else {
      return null;
    }
  }

  return fields;
}

function parseRecord(value: unknown): CodeTaskRecord | null {
  if (!isRecord(value)) return null;
  if (typeof value.requestId !== 'string' || value.requestId.length === 0) return null;
  if (typeof value.taskId !== 'string' || value.taskId.length === 0) return null;
  if (typeof value.repo !== 'string' || !REPOS.has(value.repo)) return null;
  if (typeof value.status !== 'string' || !STATUSES.has(value.status)) return null;
  if (
    typeof value.taskLength !== 'number' ||
    !Number.isInteger(value.taskLength) ||
    value.taskLength < 1
  ) {
    return null;
  }
  if (!isTimestamp(value.submittedAt) || !isTimestamp(value.updatedAt)) return null;
  if (
    !isNullableTimestamp(value.startedAt) ||
    !isNullableTimestamp(value.finishedAt) ||
    !isNullableString(value.worktree) ||
    !isNullableString(value.diffStat) ||
    !isNullableString(value.summary) ||
    !isNullableString(value.error) ||
    !isNullableTimestamp(value.cancelRequestedAt) ||
    !isNullableTimestamp(value.notifiedAt)
  ) {
    return null;
  }
  if (
    !Array.isArray(value.changedFiles) ||
    !value.changedFiles.every((entry) => typeof entry === 'string')
  ) {
    return null;
  }
  if (
    typeof value.notificationStatus !== 'string' ||
    !NOTIFICATIONS.has(value.notificationStatus)
  ) {
    return null;
  }

  const optionalFields = parseOptionalFields(value);
  if (!optionalFields) return null;
  if (optionalFields.mode === 'resume' && value.repo !== 'dsh-session') return null;
  if (optionalFields.mode === 'worktree' && value.repo === 'dsh-session') return null;

  return {
    requestId: value.requestId,
    taskId: value.taskId,
    repo: value.repo as CodeBridgeRepo,
    status: value.status as CodeTaskStatus,
    taskLength: value.taskLength,
    submittedAt: value.submittedAt,
    updatedAt: value.updatedAt,
    startedAt: value.startedAt,
    finishedAt: value.finishedAt,
    worktree: value.worktree,
    changedFiles: [...value.changedFiles],
    diffStat: value.diffStat,
    summary: value.summary,
    error: value.error,
    cancelRequestedAt: value.cancelRequestedAt,
    notificationStatus: value.notificationStatus as CodeTaskNotificationStatus,
    notifiedAt: value.notifiedAt,
    ...optionalFields,
  };
}

function cloneRecord(record: CodeTaskRecord): CodeTaskRecord {
  return {
    ...record,
    changedFiles: [...record.changedFiles],
  };
}

/**
 * `state/code-tasks.json` 的 v1 持久状态。
 * 不存任务正文、token 或 bridge 响应体；每次保存走临时文件 + rename。
 */
export class CodeTaskStore {
  private readonly filePath: string;
  private readonly onWarn: (message: string) => void;
  private readonly byRequestId = new Map<string, CodeTaskRecord>();
  private readonly byTaskId = new Map<string, CodeTaskRecord>();
  private loaded = false;

  constructor(options: CodeTaskStoreOptions) {
    this.filePath = codeTasksStatePath(options.stateDir);
    this.onWarn = options.onWarn ?? ((message) => console.warn(message));
  }

  get path(): string {
    return this.filePath;
  }

  list(): CodeTaskRecord[] {
    this.ensureLoaded();
    return [...this.byRequestId.values()].map(cloneRecord);
  }

  findByRequestId(requestId: string): CodeTaskRecord | undefined {
    this.ensureLoaded();
    const record = this.byRequestId.get(requestId);
    return record ? cloneRecord(record) : undefined;
  }

  findByTaskId(taskId: string): CodeTaskRecord | undefined {
    this.ensureLoaded();
    const record = this.byTaskId.get(taskId);
    return record ? cloneRecord(record) : undefined;
  }

  /** 写入/覆盖一条任务；requestId 与 taskId 都保持唯一映射。 */
  upsert(record: CodeTaskRecord): void {
    this.ensureLoaded();
    const existingByRequest = this.byRequestId.get(record.requestId);
    const existingByTask = this.byTaskId.get(record.taskId);
    if (existingByRequest && existingByRequest.taskId !== record.taskId) {
      throw new Error('code-tasks requestId 冲突');
    }
    if (existingByTask && existingByTask.requestId !== record.requestId) {
      throw new Error('code-tasks taskId 冲突');
    }

    const next = cloneRecord(record);
    const nextByRequestId = new Map(this.byRequestId);
    nextByRequestId.set(next.requestId, next);
    this.persist([...nextByRequestId.values()]);
    this.byRequestId.set(next.requestId, next);
    this.byTaskId.set(next.taskId, next);
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!existsSync(this.filePath)) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, 'utf8'));
    } catch {
      this.onWarn('code-tasks 状态读取失败，按空状态继续');
      return;
    }
    if (!isRecord(parsed) || parsed.v !== 1 || !Array.isArray(parsed.tasks)) {
      this.onWarn('code-tasks 状态格式无效，按空状态继续');
      return;
    }

    let skipped = 0;
    for (const item of parsed.tasks) {
      const record = parseRecord(item);
      if (
        !record ||
        this.byRequestId.has(record.requestId) ||
        this.byTaskId.has(record.taskId)
      ) {
        skipped += 1;
        continue;
      }
      this.byRequestId.set(record.requestId, record);
      this.byTaskId.set(record.taskId, record);
    }
    if (skipped > 0) this.onWarn('code-tasks 状态含无效或重复记录，已跳过');
  }

  private persist(tasks: readonly CodeTaskRecord[] = [
    ...this.byRequestId.values(),
  ]): void {
    const payload: CodeTasksFile = {
      v: 1,
      tasks: tasks.map(cloneRecord),
    };
    const tempPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      renameSync(tempPath, this.filePath);
    } catch {
      try {
        rmSync(tempPath, { force: true });
      } catch {
        // 临时文件清理失败不掩盖原始写入失败
      }
      throw new Error('code-tasks 状态写入失败');
    }
  }
}
