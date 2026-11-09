import { readFileSync } from 'node:fs';
import { isProcessAlive } from '../qq/endpoint.ts';
import { isCodeRepo, type CodeRepo } from './parser.ts';

export const CODE_BRIDGE_MAX_RESPONSE_BYTES = 64 * 1024;
export const CODE_BRIDGE_DEFAULT_TIMEOUT_MS = 5000;
export const CODE_BRIDGE_MAX_SESSIONS = 20;
export const CODE_SESSION_ID_MAX_CHARS = 128;
export const CODE_SESSION_TITLE_MAX_CHARS = 200;
export const CODE_SESSION_WORKSPACE_MAX_CHARS = 500;

const ERROR_BODY_MAX_BYTES = 4 * 1024;
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f-\u009f]/;

export type CodeTaskStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'canceled'
  | 'timed_out';

const TASK_STATUSES: ReadonlySet<string> = new Set([
  'queued',
  'running',
  'succeeded',
  'failed',
  'canceled',
  'timed_out',
]);

const ISO_TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

export type CodeBridgeRepo = CodeRepo | 'dsh-session';

export function isCodeBridgeRepo(value: string): value is CodeBridgeRepo {
  return value === 'dsh-session' || isCodeRepo(value);
}

/** 会话 id 只允许无空白的受限字符集，避免路径、控制字符或日志注入。 */
export function isSafeSessionId(value: string): boolean {
  return (
    value.length > 0 &&
    Array.from(value).length <= CODE_SESSION_ID_MAX_CHARS &&
    !CONTROL_CHARS_RE.test(value) &&
    SESSION_ID_RE.test(value)
  );
}

/** 标题/工作区展示文本：无控制字符且不超过给定 code point 上限。 */
export function isSafeSessionText(value: string, maxChars: number): boolean {
  return (
    Array.from(value).length <= maxChars && !CONTROL_CHARS_RE.test(value)
  );
}

export interface CodeBridgeTask {
  taskId: string;
  requestId: string;
  repo: CodeBridgeRepo;
  status: CodeTaskStatus;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  worktree: string | null;
  changedFiles: string[];
  diffStat: string | null;
  summary: string | null;
  error: string | null;
  cancelRequestedAt: number | null;
  sessionId?: string | null;
  workspace?: string | null;
  mode?: 'worktree' | 'resume' | 'workspace' | null;
}

export interface CodeBridgeSession {
  sessionId: string;
  title: string;
  workspace: string;
  lastUsedAt: number;
  resumable: boolean;
}

export type CodeBridgeErrorCode =
  | 'offline'
  | 'unauthorized'
  | 'queue_full'
  | 'not_found'
  | 'session_not_found'
  | 'workspace_not_found'
  | 'session_ambiguous'
  | 'workspace_ambiguous'
  | 'session_workspace_mismatch'
  | 'session_preset_incompatible'
  | 'response_invalid'
  | 'http_error'
  | 'timeout';

const SAFE_ERROR_MESSAGES: Record<CodeBridgeErrorCode, string> = {
  offline: 'code-bridge 离线',
  unauthorized: 'code-bridge 鉴权失败',
  queue_full: 'code-bridge 队列已满',
  not_found: 'code-bridge 未找到任务',
  session_not_found: 'code-bridge 未找到指定会话',
  workspace_not_found: 'code-bridge 未找到指定工作区',
  session_ambiguous: 'code-bridge 匹配到多个会话',
  workspace_ambiguous: 'code-bridge 匹配到多个工作区',
  session_workspace_mismatch: 'code-bridge 会话与工作区不匹配',
  session_preset_incompatible: 'code-bridge 会话无法用 headless 恢复',
  response_invalid: 'code-bridge 响应无效',
  http_error: 'code-bridge HTTP 错误',
  timeout: 'code-bridge 请求超时',
};

/** 归一化 bridge 错误；message 固定，不含响应体、路径或 token。 */
export class CodeBridgeError extends Error {
  readonly code: CodeBridgeErrorCode;

  constructor(code: CodeBridgeErrorCode) {
    super(SAFE_ERROR_MESSAGES[code]);
    this.name = 'CodeBridgeError';
    this.code = code;
  }
}

export interface CodeBridgeTaskInput {
  requestId: string;
  task: string;
  repo?: CodeRepo;
  session?: string;
  sessionId?: string;
  workspace?: string;
  newSession?: boolean;
}

export interface CodeBridgeHealth {
  name: 'code-bridge';
  ok: true;
}

/** manager 依赖的最小 transport 接口，便于注入 fake。 */
export interface CodeBridgeApi {
  submit(input: CodeBridgeTaskInput): Promise<CodeBridgeTask>;
  get(taskId: string): Promise<CodeBridgeTask>;
  cancel(taskId: string): Promise<CodeBridgeTask>;
  listSessions(query?: string, limit?: number): Promise<CodeBridgeSession[]>;
  health(): Promise<CodeBridgeHealth>;
}

export type CodeBridgeFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface CodeBridgeClientOptions {
  endpointFile: string;
  tokenFile: string;
  timeoutMs?: number;
  fetchImpl?: CodeBridgeFetch;
  isPidAlive?: (pid: number) => boolean;
  readFile?: (path: string) => string;
}

interface CodeBridgeEndpoint {
  baseUrl: string;
  token: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function parseIsoTimestamp(value: unknown): number | undefined {
  if (typeof value !== 'string' || !ISO_TIMESTAMP_RE.test(value)) return undefined;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? millis : undefined;
}

function nullableIsoTimestamp(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return null;
  return parseIsoTimestamp(value);
}

function nullableString(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  return typeof value === 'string' ? value : undefined;
}

function normalizeDiffStat(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  if (
    !isNonNegativeInteger(value.files) ||
    !isNonNegativeInteger(value.insertions) ||
    !isNonNegativeInteger(value.deletions)
  ) {
    return undefined;
  }
  const fileLabel = value.files === 1 ? 'file' : 'files';
  return `${value.files} ${fileLabel}, +${value.insertions}/-${value.deletions}`;
}

function sanitizeText(value: string | null, token: string): string | null {
  if (value === null) return null;
  return token.length > 0 ? value.split(token).join('[REDACTED]') : value;
}

function parseTask(value: unknown, token: string): CodeBridgeTask | null {
  if (!isRecord(value)) return null;

  if (typeof value.requestId !== 'string' || value.requestId.length === 0) return null;
  if (typeof value.taskId !== 'string' || value.taskId.length === 0) return null;
  if (typeof value.repo !== 'string' || !isCodeBridgeRepo(value.repo)) return null;
  if (typeof value.status !== 'string' || !TASK_STATUSES.has(value.status)) return null;
  if (value.requestId.includes(token) || value.taskId.includes(token)) return null;
  if (!isRecord(value.timestamps)) return null;

  const createdAt = parseIsoTimestamp(value.timestamps.createdAt);
  const updatedAt = parseIsoTimestamp(value.timestamps.updatedAt);
  const startedAt = nullableIsoTimestamp(value.timestamps.startedAt);
  const finishedAt = nullableIsoTimestamp(value.timestamps.finishedAt);
  const queuedAt = nullableIsoTimestamp(value.timestamps.queuedAt);
  if (
    createdAt === undefined ||
    updatedAt === undefined ||
    startedAt === undefined ||
    finishedAt === undefined ||
    queuedAt === undefined
  ) {
    return null;
  }

  const worktree = nullableString(value.worktree);
  const diffStat = normalizeDiffStat(value.diffStat);
  const summary = nullableString(value.summary);
  const error = nullableString(value.error);
  const cancelRequestedAt = nullableIsoTimestamp(value.cancelRequestedAt);
  if (
    worktree === undefined ||
    diffStat === undefined ||
    summary === undefined ||
    error === undefined ||
    cancelRequestedAt === undefined
  ) {
    return null;
  }
  if (typeof value.outputTruncated !== 'boolean') return null;

  let sessionId: string | null | undefined;
  if (value.sessionId !== undefined) {
    if (value.sessionId === null) {
      sessionId = null;
    } else if (
      typeof value.sessionId === 'string' &&
      isSafeSessionId(value.sessionId) &&
      !value.sessionId.includes(token)
    ) {
      sessionId = value.sessionId;
    } else {
      return null;
    }
  }

  let workspace: string | null | undefined;
  if (value.workspace !== undefined) {
    if (value.workspace === null) {
      workspace = null;
    } else if (
      typeof value.workspace === 'string' &&
      isSafeSessionText(value.workspace, CODE_SESSION_WORKSPACE_MAX_CHARS) &&
      !value.workspace.includes(token)
    ) {
      workspace = value.workspace;
    } else {
      return null;
    }
  }

  let mode: CodeBridgeTask['mode'];
  if (value.mode !== undefined) {
    if (value.mode === null) {
      mode = null;
    } else if (
      value.mode !== 'worktree' &&
      value.mode !== 'resume' &&
      value.mode !== 'workspace'
    ) {
      return null;
    } else {
      mode = value.mode;
    }
    if (mode === 'resume' && value.repo !== 'dsh-session') return null;
    if (mode === 'worktree' && value.repo === 'dsh-session') return null;
  }

  if (
    !Array.isArray(value.changedFiles) ||
    value.changedFiles.length > 1000 ||
    !value.changedFiles.every((entry) => typeof entry === 'string')
  ) {
    return null;
  }
  const changedFiles = [...value.changedFiles];

  const task: CodeBridgeTask = {
    taskId: value.taskId,
    requestId: value.requestId,
    repo: value.repo,
    status: value.status as CodeTaskStatus,
    createdAt,
    updatedAt,
    startedAt,
    finishedAt,
    worktree: sanitizeText(worktree, token),
    changedFiles: changedFiles.map((entry) => sanitizeText(entry, token) ?? ''),
    diffStat,
    summary: sanitizeText(summary, token),
    error: sanitizeText(error, token),
    cancelRequestedAt,
  };
  if (sessionId !== undefined) task.sessionId = sessionId;
  if (workspace !== undefined) task.workspace = workspace;
  if (mode !== undefined) task.mode = mode;
  return task;
}

function parseTaskEnvelope(value: unknown, token: string): CodeBridgeTask | null {
  if (!isRecord(value) || value.ok !== true) return null;
  if (value.duplicate !== undefined && typeof value.duplicate !== 'boolean') {
    return null;
  }
  return parseTask(value.task, token);
}

function parseSession(value: unknown, token: string): CodeBridgeSession | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.sessionId !== 'string' ||
    !isSafeSessionId(value.sessionId) ||
    value.sessionId.includes(token)
  ) {
    return null;
  }
  if (
    typeof value.title !== 'string' ||
    !isSafeSessionText(value.title, CODE_SESSION_TITLE_MAX_CHARS) ||
    value.title.includes(token)
  ) {
    return null;
  }
  if (
    typeof value.workspace !== 'string' ||
    !isSafeSessionText(value.workspace, CODE_SESSION_WORKSPACE_MAX_CHARS) ||
    value.workspace.includes(token)
  ) {
    return null;
  }
  const lastUsedAt = parseIsoTimestamp(value.lastUsedAt);
  if (lastUsedAt === undefined) return null;
  let resumable = true;
  if (value.resumable !== undefined) {
    if (typeof value.resumable !== 'boolean') return null;
    resumable = value.resumable;
  }
  return {
    sessionId: value.sessionId,
    title: value.title,
    workspace: value.workspace,
    lastUsedAt,
    resumable,
  };
}

function parseSessionsEnvelope(
  value: unknown,
  token: string,
): CodeBridgeSession[] | null {
  if (!isRecord(value) || value.ok !== true) return null;
  if (
    !Array.isArray(value.sessions) ||
    value.sessions.length > CODE_BRIDGE_MAX_SESSIONS
  ) {
    return null;
  }

  const sessions: CodeBridgeSession[] = [];
  const seen = new Set<string>();
  for (const item of value.sessions) {
    const session = parseSession(item, token);
    if (!session || seen.has(session.sessionId)) return null;
    seen.add(session.sessionId);
    sessions.push(session);
  }
  return sessions;
}

function parseHealth(value: unknown): CodeBridgeHealth | null {
  if (!isRecord(value)) return null;
  if (value.name !== 'code-bridge' || value.ok !== true) return null;
  return { name: 'code-bridge', ok: true };
}

function cancelBody(response: Response): void {
  if (!response.body) return;
  void response.body.cancel().catch(() => undefined);
}

/**
 * code-bridge 的本地回环客户端。
 *
 * 每次 API 调用都会重新读端点文件和 token 文件；token 只进入
 * `x-code-bridge-token` 请求头，不缓存、不记录、不回显。
 */
export class CodeBridgeClient implements CodeBridgeApi {
  private readonly endpointFile: string;
  private readonly tokenFile: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: CodeBridgeFetch;
  private readonly isPidAlive: (pid: number) => boolean;
  private readonly readFile: (path: string) => string;

  constructor(options: CodeBridgeClientOptions) {
    this.endpointFile = options.endpointFile;
    this.tokenFile = options.tokenFile;
    this.timeoutMs = options.timeoutMs ?? CODE_BRIDGE_DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.isPidAlive = options.isPidAlive ?? isProcessAlive;
    this.readFile = options.readFile ?? ((path) => readFileSync(path, 'utf8'));
  }

  async submit(input: CodeBridgeTaskInput): Promise<CodeBridgeTask> {
    const hasTarget =
      input.session !== undefined ||
      input.sessionId !== undefined ||
      input.workspace !== undefined;
    if (input.repo === undefined && !hasTarget) {
      throw new CodeBridgeError('response_invalid');
    }

    const body: Record<string, unknown> = {
      requestId: input.requestId,
      task: input.task,
    };
    if (input.repo !== undefined) body.repo = input.repo;
    if (input.session !== undefined) body.session = input.session;
    if (input.sessionId !== undefined) body.sessionId = input.sessionId;
    if (input.workspace !== undefined) body.workspace = input.workspace;
    if (input.newSession !== undefined) body.newSession = input.newSession;

    const task = await this.requestTask('POST', '/v1/tasks', body);
    if (task.requestId !== input.requestId) {
      throw new CodeBridgeError('response_invalid');
    }
    if (
      input.sessionId !== undefined &&
      task.sessionId !== input.sessionId
    ) {
      throw new CodeBridgeError('response_invalid');
    }
    if (input.repo !== undefined) {
      if (hasTarget) {
        if (task.mode === 'worktree' && task.repo !== input.repo) {
          throw new CodeBridgeError('response_invalid');
        }
      } else if (task.repo !== input.repo) {
        throw new CodeBridgeError('response_invalid');
      }
    }
    if (task.sessionId !== undefined && task.sessionId !== null) {
      if (!isSafeSessionId(task.sessionId)) {
        throw new CodeBridgeError('response_invalid');
      }
    }
    if (task.mode === 'resume' && task.repo !== 'dsh-session') {
      throw new CodeBridgeError('response_invalid');
    }
    return task;
  }

  async get(taskId: string): Promise<CodeBridgeTask> {
    const task = await this.requestTask('GET', `/v1/tasks/${encodeURIComponent(taskId)}`);
    if (task.taskId !== taskId) throw new CodeBridgeError('response_invalid');
    return task;
  }

  async cancel(taskId: string): Promise<CodeBridgeTask> {
    const task = await this.requestTask(
      'POST',
      `/v1/tasks/${encodeURIComponent(taskId)}/cancel`,
      {},
    );
    if (task.taskId !== taskId) throw new CodeBridgeError('response_invalid');
    return task;
  }

  async listSessions(query?: string, limit?: number): Promise<CodeBridgeSession[]> {
    const params = new URLSearchParams();
    if (query !== undefined && query.trim().length > 0) {
      params.set('q', query.trim());
    }
    if (
      limit !== undefined &&
      Number.isInteger(limit) &&
      limit > 0 &&
      limit <= CODE_BRIDGE_MAX_SESSIONS
    ) {
      params.set('limit', String(limit));
    }
    const suffix = params.size > 0 ? `?${params.toString()}` : '';
    return this.performRequest('GET', `/v1/sessions${suffix}`, undefined, async (
      response,
      token,
    ) => {
      if (response.status !== 200) {
        throw new CodeBridgeError(await this.errorCodeForResponse(response));
      }
      const payload = await this.readJson(response);
      const sessions = parseSessionsEnvelope(payload, token);
      if (!sessions) throw new CodeBridgeError('response_invalid');
      return sessions;
    });
  }

  async health(): Promise<CodeBridgeHealth> {
    return this.performRequest('GET', '/health', undefined, async (response) => {
      if (response.status !== 200) {
        cancelBody(response);
        throw new CodeBridgeError(this.errorCodeForStatus(response.status));
      }
      const payload = await this.readJson(response);
      const health = parseHealth(payload);
      if (!health) throw new CodeBridgeError('response_invalid');
      return health;
    });
  }

  private discover(): CodeBridgeEndpoint & { token: string } {
    let parsed: unknown;
    try {
      parsed = JSON.parse(this.readFile(this.endpointFile));
    } catch {
      throw new CodeBridgeError('offline');
    }
    if (!isRecord(parsed)) throw new CodeBridgeError('offline');
    if (
      parsed.v !== 1 ||
      parsed.name !== 'code-bridge' ||
      parsed.host !== '127.0.0.1' ||
      typeof parsed.port !== 'number' ||
      !Number.isInteger(parsed.port) ||
      parsed.port < 1 ||
      parsed.port > 65_535 ||
      typeof parsed.pid !== 'number' ||
      !Number.isInteger(parsed.pid) ||
      parsed.pid <= 0 ||
      !this.isPidAlive(parsed.pid)
    ) {
      throw new CodeBridgeError('offline');
    }

    let token: string;
    try {
      token = this.readFile(this.tokenFile).trim();
    } catch {
      throw new CodeBridgeError('offline');
    }
    if (token.length === 0) throw new CodeBridgeError('offline');

    return {
      baseUrl: `http://127.0.0.1:${parsed.port}`,
      token,
    };
  }

  private async performRequest<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    handle?: (response: Response, token: string) => Promise<T>,
  ): Promise<T> {
    const endpoint = this.discover();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${endpoint.baseUrl}${path}`, {
        method,
        redirect: 'error',
        headers: {
          'x-code-bridge-token': endpoint.token,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      if (!handle) throw new CodeBridgeError('response_invalid');
      return await handle(response, endpoint.token);
    } catch (err) {
      if (err instanceof CodeBridgeError) throw err;
      if (controller.signal.aborted) throw new CodeBridgeError('timeout');
      throw new CodeBridgeError('offline');
    } finally {
      clearTimeout(timer);
    }
  }

  private async requestTask(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<CodeBridgeTask> {
    return this.performRequest(method, path, body, async (response, token) => {
      if (
        (method === 'POST' && !(response.status === 200 || response.status === 202)) ||
        (method === 'GET' && response.status !== 200)
      ) {
        throw new CodeBridgeError(await this.errorCodeForResponse(response));
      }

      const payload = await this.readJson(response);
      const task = parseTaskEnvelope(payload, token);
      if (!task) throw new CodeBridgeError('response_invalid');
      return task;
    });
  }

  private async readJson(response: Response): Promise<unknown> {
    const declaredLength = Number(response.headers.get('content-length'));
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > CODE_BRIDGE_MAX_RESPONSE_BYTES
    ) {
      cancelBody(response);
      throw new CodeBridgeError('response_invalid');
    }

    if (!response.body) throw new CodeBridgeError('response_invalid');
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > CODE_BRIDGE_MAX_RESPONSE_BYTES) {
          await reader.cancel().catch(() => undefined);
          throw new CodeBridgeError('response_invalid');
        }
        chunks.push(Buffer.from(value));
      }
    } catch (err) {
      if (err instanceof CodeBridgeError) throw err;
      if (err instanceof Error && err.name === 'AbortError') throw err;
      throw new CodeBridgeError('offline');
    }

    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new CodeBridgeError('response_invalid');
    }
  }

  private errorCodeForStatus(status: number): CodeBridgeErrorCode {
    if (status === 401 || status === 403) return 'unauthorized';
    if (status === 404) return 'not_found';
    if (status === 429) return 'queue_full';
    if (status === 408 || status === 504) return 'timeout';
    return 'http_error';
  }

  /**
   * 404/409 需要区分任务、会话与工作区；只在小响应体里读取稳定 error 字段，
   * 绝不把 body 原文带进错误消息。
   */
  private async errorCodeForResponse(
    response: Response,
  ): Promise<CodeBridgeErrorCode> {
    const status = response.status;
    if (status !== 404 && status !== 409) {
      cancelBody(response);
      return this.errorCodeForStatus(status);
    }

    const bodyCode = await this.readErrorCode(response);
    if (status === 404) {
      if (bodyCode === 'session_not_found') return 'session_not_found';
      if (bodyCode === 'workspace_not_found') return 'workspace_not_found';
      return 'not_found';
    }
    if (bodyCode === 'session_ambiguous') return 'session_ambiguous';
    if (bodyCode === 'workspace_ambiguous') return 'workspace_ambiguous';
    if (bodyCode === 'session_workspace_mismatch') {
      return 'session_workspace_mismatch';
    }
    if (bodyCode === 'session_preset_incompatible') {
      return 'session_preset_incompatible';
    }
    return 'http_error';
  }

  private async readErrorCode(response: Response): Promise<string | null> {
    if (!response.body) return null;

    const declaredLength = Number(response.headers.get('content-length'));
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > ERROR_BODY_MAX_BYTES
    ) {
      cancelBody(response);
      return null;
    }

    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > ERROR_BODY_MAX_BYTES) {
          await reader.cancel().catch(() => undefined);
          return null;
        }
        chunks.push(Buffer.from(value));
      }
    } catch {
      return null;
    }

    try {
      const payload: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!isRecord(payload)) return null;
      const value = payload.error ?? payload.code;
      return typeof value === 'string' ? value : null;
    } catch {
      return null;
    }
  }
}
