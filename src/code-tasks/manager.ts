import {
  CODE_SESSION_TITLE_MAX_CHARS,
  CODE_SESSION_WORKSPACE_MAX_CHARS,
  CodeBridgeError,
  isSafeSessionText,
  type CodeBridgeApi,
  type CodeBridgeSession,
  type CodeBridgeTask,
  type CodeBridgeTaskInput,
} from './bridge-client.ts';
import {
  CODE_SESSIONS_QUERY_MAX_CHARS,
  CODE_TASK_MAX_CHARS,
  isCodeRepo,
  parseCodeCommand,
  stripMentionSeparators,
  type CodeRepo,
} from './parser.ts';
import {
  CodeTaskStore,
  type CodeTaskRecord,
  type CodeTaskNotificationStatus,
} from './store.ts';
import type { QqSender, SendResult } from '../qq/types.ts';

const TERMINAL_STATUSES: ReadonlySet<CodeTaskRecord['status']> = new Set([
  'succeeded',
  'failed',
  'canceled',
  'timed_out',
]);
const ACTIVE_STATUSES: ReadonlySet<CodeTaskRecord['status']> = new Set([
  'queued',
  'running',
]);
const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_SUMMARY_MAX_CHARS = 1200;
const ERROR_MAX_CHARS = 300;
const DIFF_STAT_MAX_CHARS = 500;
const WORKTREE_MAX_CHARS = 500;
const RECENT_TERMINAL_LIMIT = 5;
const ACTIVE_LIST_LIMIT = 8;
const SESSION_DISPLAY_LIMIT = 10;
const SESSION_FETCH_LIMIT = 20;
const TOOL_RESULT_MAX_CHARS = 4000;
const TOOL_TASK_PREVIEW_CHARS = 80;
const TOOL_REQUEST_ID_MAX_CHARS = 256;

const CANDIDATE_ERROR_CODES: ReadonlySet<string> = new Set([
  'session_not_found',
  'workspace_not_found',
  'session_ambiguous',
  'workspace_ambiguous',
  'session_preset_incompatible',
]);

export interface CodeCommandSource {
  kind: 'private' | 'group';
  id: string;
}

export interface IncomingCodeCommand {
  requestId: string;
  text: string;
  source: CodeCommandSource;
  senderQQ: string;
  /** 群聊必须由 owner 显式 @/引用触发；私聊忽略。 */
  isAtBot?: boolean;
}

export interface CodeToolCallInput {
  requestId: string;
  tool: string;
  argumentsText: string;
  /** runtime 注入的调用来源；提供时 manager 必须二次校验为 owner 私聊。 */
  source?: CodeCommandSource;
  senderQQ?: string;
}

interface SubmissionTarget {
  repo?: CodeRepo;
  session?: string;
  sessionId?: string;
  workspace?: string;
  newSession?: boolean;
}

export interface CodeTaskManagerOptions {
  ownerQQ: number;
  store: CodeTaskStore;
  bridge: CodeBridgeApi;
  sender: QqSender;
  /** 允许 owner 在群内显式使用 code 命令的白名单群。 */
  allowGroups?: readonly number[];
  pollIntervalMs?: number;
  summaryMaxChars?: number;
  now?: () => number;
  onWarn?: (message: string) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTerminal(status: CodeTaskRecord['status']): boolean {
  return TERMINAL_STATUSES.has(status);
}

function clip(text: string, maxChars: number): string {
  const chars = Array.from(text);
  if (chars.length <= maxChars) return text;
  return `${chars.slice(0, Math.max(0, maxChars - 1)).join('')}…`;
}

function clipNullable(text: string | null, maxChars: number): string | null {
  return text === null ? null : clip(text, maxChars);
}

function singleLine(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** 展示用工作区标签：绝对路径只保留最后一段，避免把本机路径带进 QQ/工具结果。 */
function workspaceLabel(workspace: string | null | undefined): string {
  const raw = singleLine(workspace ?? '');
  if (raw.length === 0) return '无工作区';
  const normalized = raw.replace(/\\/g, '/');
  const absolute =
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.startsWith('//') ||
    normalized.startsWith('/');
  if (!absolute) return clip(raw, 80);
  const parts = normalized.split('/').filter((part) => part.length > 0);
  return clip(parts.at(-1) ?? '工作区', 80);
}

function titleLabel(title: string): string {
  const value = singleLine(title);
  if (value.length === 0) return '未命名会话';
  const normalized = value.replace(/\\/g, '/');
  if (
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.startsWith('//') ||
    normalized.startsWith('/')
  ) {
    return workspaceLabel(value);
  }
  return clip(value, 80);
}

function shortSessionId(sessionId: string): string {
  const prefix = 'session-';
  const hasPrefix = sessionId.startsWith(prefix);
  const chars = Array.from(hasPrefix ? sessionId.slice(prefix.length) : sessionId);
  if (chars.length <= 8) return sessionId;
  const short = chars.slice(0, 8).join('');
  return hasPrefix ? `${prefix}${short}` : `${short}…`;
}

function formatRecentUse(lastUsedAt: number): string {
  const date = new Date(lastUsedAt);
  if (!Number.isFinite(date.getTime())) return '未知';
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

function taskPreview(task: string): string {
  const chars = Array.from(singleLine(task));
  if (chars.length <= TOOL_TASK_PREVIEW_CHARS) return chars.join('');
  return chars.slice(0, TOOL_TASK_PREVIEW_CHARS).join('');
}

function validIndexes(value: unknown): value is number[] {
  if (!Array.isArray(value)) return false;
  const seen = new Set<number>();
  for (const index of value) {
    if (index !== 0 || seen.has(index)) return false;
    seen.add(index);
  }
  return true;
}

function notificationOutcome(
  result: SendResult,
): CodeTaskNotificationStatus | 'pending' | 'invalid' {
  if (!isRecord(result)) return 'invalid';
  if (!validIndexes(result.sentIndexes) || !validIndexes(result.failedIndexes)) {
    return 'invalid';
  }
  const sent = result.sentIndexes;
  const failed = result.failedIndexes;
  if (sent.includes(0) && failed.includes(0)) return 'invalid';
  if (
    result.outcome !== 'all_sent' &&
    result.outcome !== 'partial' &&
    result.outcome !== 'none_sent' &&
    result.outcome !== 'ambiguous_failure'
  ) {
    return 'invalid';
  }
  if (result.outcome === 'ambiguous_failure') return 'ambiguous';
  if (result.outcome === 'all_sent') {
    return failed.length === 0 ? 'sent' : 'invalid';
  }
  if (sent.includes(0)) return 'sent';
  if (result.outcome === 'none_sent') return 'pending';
  return 'invalid';
}

function parseToolArguments(raw: string): Record<string, unknown> | null {
  if (raw.trim().length === 0) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value)) return null;
    return value;
  } catch {
    return null;
  }
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

function toolError(code: string, message: string): string {
  return `[code_tool_error:${code}] ${message}`;
}

/**
 * `code` 命令与后台任务状态机。
 *
 * - 只有 owner 私聊，或白名单群内 owner 显式 @ 的控制命令会建任务；
 *   其余来源最多得到一条拒绝消息。
 * - 提交 ACK 不等待执行；执行结果由 pollOnce 通过 owner 私聊 proactive 消息回送。
 * - SendResult 歧义一律标记 ambiguous，绝不重发。
 */
export class CodeTaskManager {
  private readonly ownerQQ: number;
  private readonly ownerId: string;
  private readonly store: CodeTaskStore;
  private readonly bridge: CodeBridgeApi;
  private readonly sender: QqSender;
  private readonly allowGroups: Set<string>;
  private readonly pollIntervalMs: number;
  private readonly summaryMaxChars: number;
  private readonly now: () => number;
  private readonly onWarn: (message: string) => void;

  private timer: NodeJS.Timeout | null = null;
  private pollOperation: Promise<void> | null = null;
  private stopping = false;
  private readonly submitOperations = new Map<string, Promise<string[]>>();

  constructor(options: CodeTaskManagerOptions) {
    this.ownerQQ = options.ownerQQ;
    this.ownerId = String(options.ownerQQ);
    this.store = options.store;
    this.bridge = options.bridge;
    this.sender = options.sender;
    this.allowGroups = new Set((options.allowGroups ?? []).map(String));
    this.pollIntervalMs =
      options.pollIntervalMs !== undefined && options.pollIntervalMs > 0
        ? options.pollIntervalMs
        : DEFAULT_POLL_INTERVAL_MS;
    this.summaryMaxChars =
      options.summaryMaxChars !== undefined && options.summaryMaxChars > 0
        ? options.summaryMaxChars
        : DEFAULT_SUMMARY_MAX_CHARS;
    this.now = options.now ?? Date.now;
    this.onWarn = options.onWarn ?? ((message) => console.warn(message));
  }

  /** 启动轮询；立即跑一次，以便重启后恢复未完成状态与待发送终态。 */
  start(): void {
    if (this.timer !== null) return;
    this.stopping = false;
    this.timer = setInterval(() => {
      void this.pollOnce().catch(() => this.safeWarn('code 任务轮询失败'));
    }, this.pollIntervalMs);
    this.timer.unref?.();
    void this.pollOnce().catch(() => this.safeWarn('code 任务轮询失败'));
  }

  /** 清理 timer 并等待进行中的 poll 结束。 */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.pollOperation;
  }

  async handleIncoming(input: IncomingCodeCommand): Promise<string[]> {
    const ownerPrivate =
      input.source.kind === 'private' &&
      input.source.id === this.ownerId &&
      input.senderQQ === this.ownerId &&
      this.ownerQQ !== 0;
    const ownerGroup =
      input.source.kind === 'group' &&
      input.senderQQ === this.ownerId &&
      input.isAtBot === true &&
      this.allowGroups.has(input.source.id) &&
      this.ownerQQ !== 0;
    if (!ownerPrivate && !ownerGroup) {
      return ['仅 owner 私聊或已授权群聊 @ 可使用 code 命令。'];
    }

    const commandText = ownerGroup
      ? stripMentionSeparators(input.text)
      : input.text;
    const parsed = parseCodeCommand(commandText);
    if (parsed.kind === 'usage') return [this.usageMessage()];
    if (parsed.kind === 'sessions') return this.listSessionsMessage(parsed.query);
    if (parsed.kind === 'status') return [this.statusMessage()];
    if (parsed.kind === 'cancel') return this.cancelTask(parsed.taskId);
    return this.submitTask(input.requestId, parsed.repo, parsed.task);
  }

  /**
   * 当前 DSH 会话列表。最多展示 10 条；多出的部分明确告诉 owner 还有多少。
   * 工作区只展示安全标签，不回显本机绝对路径。
   */
  async listSessionsMessage(query?: string): Promise<string[]> {
    const rawQuery = query ?? '';
    if (
      /[\r\n]/.test(rawQuery) ||
      Array.from(rawQuery.trim()).length > CODE_SESSIONS_QUERY_MAX_CHARS
    ) {
      return ['会话查询不合法：关键词必须单行且不超过 100 字。'];
    }
    const normalizedQuery = rawQuery.trim();
    const displayQuery = singleLine(normalizedQuery);

    let sessions: CodeBridgeSession[];
    try {
      sessions = await this.bridge.listSessions(
        normalizedQuery.length > 0 ? normalizedQuery : undefined,
        SESSION_FETCH_LIMIT,
      );
    } catch (err) {
      return [this.sessionListErrorMessage(err)];
    }

    const visible = sessions.slice(0, SESSION_DISPLAY_LIMIT);
    const lines = [
      normalizedQuery.length > 0
        ? `匹配“${clip(displayQuery, 40)}”的 DSH 会话：`
        : '当前 DSH 会话（按最近使用）：',
    ];
    if (visible.length === 0) {
      lines.push(
        normalizedQuery.length > 0
          ? '没有找到匹配的会话。'
          : '当前没有可用的 DSH 会话。',
      );
      return [clip(lines.join('\n'), TOOL_RESULT_MAX_CHARS)];
    }

    visible.forEach((session, index) => {
      const resumable = session.resumable !== false;
      lines.push(
        `${index + 1}. ${titleLabel(session.title)}（${shortSessionId(session.sessionId)}）` +
          `— ${workspaceLabel(session.workspace)}；最近 ${formatRecentUse(session.lastUsedAt)}` +
          (resumable ? '' : '；不可恢复（桌面端预设）'),
      );
    });
    if (sessions.length > visible.length) {
      lines.push(
        `还有 ${sessions.length - visible.length} 个；可用 code sessions <关键词> 缩小范围。`,
      );
    }
    if (visible.some((session) => session.resumable === false)) {
      lines.push(
        '标记“不可恢复”的会话只能在桌面端继续；要执行代码任务请选择其他会话，或用 workspace + newSession: true 新建。',
      );
    }
    return [clip(lines.join('\n'), TOOL_RESULT_MAX_CHARS)];
  }

  /**
   * owner 私聊模型工具的统一入口。runtime 只会在 owner 私聊中注入本工具，
   * 但 manager 仍对显式传入的来源做二次校验。
   */
  async handleToolCall(input: CodeToolCallInput): Promise<string[]> {
    if (!this.validToolRequestId(input.requestId)) {
      return [toolError('invalid_request', '请求标识不合法。')];
    }
    if (!this.validToolSource(input)) {
      return [toolError('forbidden', '仅 owner 私聊可使用代码工具。')];
    }

    if (input.tool === 'code_sessions') {
      const args = parseToolArguments(input.argumentsText);
      if (!args) return [toolError('invalid_arguments', '会话查询参数格式不正确。')];
      if (!hasOnlyKeys(args, ['query'])) {
        return [toolError('invalid_arguments', '会话查询参数格式不正确。')];
      }
      if (
        args.query !== undefined &&
        (typeof args.query !== 'string' ||
          /[\u0000-\u001f\u007f-\u009f]/.test(args.query) ||
          Array.from(args.query.trim()).length > CODE_SESSIONS_QUERY_MAX_CHARS)
      ) {
        return [toolError('invalid_arguments', '会话查询关键词必须单行且不超过 100 字。')];
      }
      return this.listSessionsMessage(
        typeof args.query === 'string' ? args.query : undefined,
      );
    }

    if (input.tool === 'code_status') {
      const args = parseToolArguments(input.argumentsText);
      if (!args || !hasOnlyKeys(args, [])) {
        return [toolError('invalid_arguments', '状态查询参数格式不正确。')];
      }
      return [this.statusMessage()];
    }

    if (input.tool === 'code_task') {
      return this.handleCodeTaskTool(input.requestId, input.argumentsText);
    }

    return [toolError('unknown_tool', '未知代码工具。')];
  }

  /**
   * 顺序轮询非终态任务；随后单条发送所有 pending 的终态通知。
   * 同一定时器周期内不允许重入。
   */
  pollOnce(): Promise<void> {
    if (this.pollOperation) return this.pollOperation;
    const operation = this.performPoll().finally(() => {
      if (this.pollOperation === operation) this.pollOperation = null;
    });
    this.pollOperation = operation;
    return operation;
  }

  private usageMessage(): string {
    return [
      '用法：code <repo> <task>；code sessions [关键词]；code status；code cancel <taskId>。',
      '可用 repo：ds-memory、martilyric、qq-gateway、xtds、xtds-assistant-dsh。',
      `任务长度 1..${CODE_TASK_MAX_CHARS} 字符。`,
      '群聊中仅 owner @ 我时生效；普通群友的 code 命令会被忽略。',
      '群聊示例：@我 code sessions；@我 code ds-memory 看一下项目结构。',
    ].join('\n');
  }

  private submitTask(requestId: string, repo: CodeRepo, task: string): Promise<string[]> {
    return this.submitSubmission(requestId, { repo }, task, 'command');
  }

  private submitSubmission(
    requestId: string,
    target: SubmissionTarget,
    task: string,
    ackStyle: 'command' | 'tool',
  ): Promise<string[]> {
    const existing = this.store.findByRequestId(requestId);
    if (existing) {
      return ackStyle === 'tool'
        ? this.toolSubmittedAck(existing, target, task)
        : Promise.resolve([this.submittedAck(existing)]);
    }

    const inFlight = this.submitOperations.get(requestId);
    if (inFlight) return inFlight;

    const operation = this.performSubmit(requestId, target, task, ackStyle).finally(() => {
      if (this.submitOperations.get(requestId) === operation) {
        this.submitOperations.delete(requestId);
      }
    });
    this.submitOperations.set(requestId, operation);
    return operation;
  }

  private async performSubmit(
    requestId: string,
    target: SubmissionTarget,
    task: string,
    ackStyle: 'command' | 'tool',
  ): Promise<string[]> {
    try {
      const input: CodeBridgeTaskInput = { requestId, task };
      if (target.repo !== undefined) input.repo = target.repo;
      if (target.session !== undefined) input.session = target.session;
      if (target.sessionId !== undefined) input.sessionId = target.sessionId;
      if (target.workspace !== undefined) input.workspace = target.workspace;
      if (target.newSession !== undefined) input.newSession = target.newSession;

      const bridgeTask = await this.bridge.submit(input);
      if (bridgeTask.requestId !== requestId) {
        return ['代码桥响应异常，无法确认任务是否提交。'];
      }
      if (
        target.repo !== undefined &&
        target.session === undefined &&
        target.sessionId === undefined &&
        target.workspace === undefined &&
        bridgeTask.repo !== target.repo
      ) {
        return ['代码桥响应异常，无法确认任务是否提交。'];
      }
      if (
        target.sessionId !== undefined &&
        bridgeTask.sessionId !== target.sessionId
      ) {
        return ['代码桥响应异常，无法确认任务是否提交。'];
      }
      if (bridgeTask.mode === 'resume' && bridgeTask.repo !== 'dsh-session') {
        return ['代码桥响应异常，无法确认任务是否提交。'];
      }

      const record = this.recordFromTask(bridgeTask, Array.from(task).length);
      let persisted = true;
      try {
        this.store.upsert(record);
      } catch {
        persisted = false;
        this.safeWarn('code-tasks 状态保存失败');
      }
      const successMessage =
        ackStyle === 'tool'
          ? await this.toolSubmittedAck(record, target, task)
          : [this.submittedAck(record)];
      return [
        persisted
          ? successMessage[0]!
          : ackStyle === 'tool'
            ? this.toolSubmittedAckText(record, await this.resolveToolTargetLabel(record, target), task, true)
            : `已提交代码任务 ${record.taskId}（${this.recordTargetLabel(record)}），但本地状态保存失败。`,
      ];
    } catch (err) {
      if (ackStyle === 'tool') return this.toolSubmitErrorMessages(err);
      return [this.submitErrorMessage(err)];
    }
  }

  private submittedAck(record: CodeTaskRecord): string {
    return `已提交代码任务 ${record.taskId}（${this.recordTargetLabel(record)}）`;
  }

  private async toolSubmittedAck(
    record: CodeTaskRecord,
    target: SubmissionTarget,
    task: string,
  ): Promise<string[]> {
    const label = await this.resolveToolTargetLabel(record, target);
    return [this.toolSubmittedAckText(record, label, task, false)];
  }

  private toolSubmittedAckText(
    record: CodeTaskRecord,
    targetLabel: string,
    task: string,
    persistFailed: boolean,
  ): string {
    const preview = taskPreview(task);
    const suffix = persistFailed ? '，但本地状态保存失败' : '';
    return (
      `已提交代码任务 ${record.taskId}（目标：${targetLabel}）${suffix}\n` +
      `任务预览：${preview}${Array.from(singleLine(task)).length > TOOL_TASK_PREVIEW_CHARS ? '…' : ''}`
    );
  }

  private submitErrorMessage(err: unknown): string {
    if (!(err instanceof CodeBridgeError)) return '代码任务提交失败。';
    switch (err.code) {
      case 'offline':
        return '代码桥离线，任务未提交。';
      case 'unauthorized':
        return '代码桥鉴权失败，任务未提交。';
      case 'queue_full':
        return '代码任务队列已满，请稍后再试。';
      case 'timeout':
        return '代码桥响应超时，无法确认任务是否提交。';
      case 'response_invalid':
        return '代码桥响应异常，无法确认任务是否提交。';
      case 'not_found':
        return '代码桥未找到任务，任务未提交。';
      case 'session_not_found':
        return '找不到指定会话，任务未提交。';
      case 'workspace_not_found':
        return '找不到指定工作区，任务未提交。';
      case 'session_ambiguous':
        return '会话名不唯一，任务未提交。请从候选会话中选择更精确的名称或 id。';
      case 'workspace_ambiguous':
        return '工作区名不唯一，任务未提交。请从候选工作区中选择更精确的名称。';
      case 'session_workspace_mismatch':
        return '会话与工作区不匹配，任务未提交。';
      case 'session_preset_incompatible':
        return '该会话由桌面端预设创建，headless 无法恢复；请改用工作区新建任务（newSession: true）或其他会话。';
      case 'http_error':
        return '代码桥返回错误，任务未提交。';
    }
  }

  private async cancelTask(taskId: string): Promise<string[]> {
    const record = this.store.findByTaskId(taskId);
    if (!record) return [`未找到代码任务 ${taskId}。`];
    if (isTerminal(record.status)) {
      return [`代码任务 ${taskId} 已结束（${record.status}），无需取消。`];
    }
    if (record.cancelRequestedAt !== null) {
      return [`已请求取消代码任务 ${taskId}（${this.recordTargetLabel(record)}）。`];
    }

    try {
      const bridgeTask = await this.bridge.cancel(taskId);
      if (
        bridgeTask.taskId !== taskId ||
        bridgeTask.requestId !== record.requestId ||
        bridgeTask.repo !== record.repo
      ) {
        return ['代码桥响应异常，取消失败。'];
      }
      const next: CodeTaskRecord = {
        ...record,
        ...this.taskMetadata(bridgeTask),
        cancelRequestedAt: this.now(),
        notificationStatus: record.notificationStatus,
      };
      try {
        this.store.upsert(next);
      } catch {
        this.safeWarn('code-tasks 状态保存失败');
      }
      return [`已请求取消代码任务 ${taskId}（${this.recordTargetLabel(record)}）。`];
    } catch (err) {
      return [this.cancelErrorMessage(err)];
    }
  }

  private cancelErrorMessage(err: unknown): string {
    if (!(err instanceof CodeBridgeError)) return '代码任务取消失败。';
    switch (err.code) {
      case 'offline':
        return '代码桥离线，无法取消。';
      case 'unauthorized':
        return '代码桥鉴权失败，无法取消。';
      case 'not_found':
        return '代码桥未找到该任务，取消失败。';
      case 'queue_full':
        return '代码桥忙碌，暂时无法取消。';
      case 'timeout':
        return '代码桥响应超时，无法确认取消是否生效。';
      case 'response_invalid':
        return '代码桥响应异常，取消失败。';
      case 'session_not_found':
      case 'workspace_not_found':
      case 'session_ambiguous':
      case 'workspace_ambiguous':
      case 'session_workspace_mismatch':
      case 'session_preset_incompatible':
        return '代码桥会话解析失败，取消失败。';
      case 'http_error':
        return '代码桥返回错误，取消失败。';
    }
  }

  private statusMessage(): string {
    const tasks = this.store.list();
    if (tasks.length === 0) return '暂无代码任务。';

    const queued = tasks.filter((task) => task.status === 'queued');
    const running = tasks.filter((task) => task.status === 'running');
    const active = [...queued, ...running].sort(
      (left, right) => left.submittedAt - right.submittedAt,
    );
    const recent = tasks
      .filter((task) => isTerminal(task.status))
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, RECENT_TERMINAL_LIMIT);

    const lines = [
      `代码任务：排队 ${queued.length}，运行 ${running.length}，最近终态 ${recent.length}。`,
    ];
    if (active.length > 0) {
      const shown = active
        .slice(0, ACTIVE_LIST_LIMIT)
        .map((task) => `${task.taskId}（${this.recordTargetLabel(task)}）：${task.status}`)
        .join('；');
      lines.push(
        active.length > ACTIVE_LIST_LIMIT
          ? `进行中：${shown}；等 ${active.length - ACTIVE_LIST_LIMIT} 个`
          : `进行中：${shown}`,
      );
    }
    if (recent.length > 0) {
      lines.push(
        `最近：${recent
          .map((task) => {
            const reason = task.status === 'failed' && task.error
              ? `，${this.taskErrorLabel(task.error)}`
              : '';
            return `${task.taskId}（${this.recordTargetLabel(task)}）：${task.status}${reason}`;
          })
          .join('；')}`,
      );
    }
    return clip(lines.join('\n'), this.summaryMaxChars);
  }

  private async handleCodeTaskTool(
    requestId: string,
    argumentsText: string,
  ): Promise<string[]> {
    const args = parseToolArguments(argumentsText);
    if (!args) return [toolError('invalid_arguments', '代码任务参数格式不正确。')];
    if (
      !hasOnlyKeys(args, ['task', 'repo', 'session', 'workspace', 'newSession'])
    ) {
      return [toolError('invalid_arguments', '代码任务参数格式不正确。')];
    }

    if (typeof args.task !== 'string') {
      return [toolError('missing_task', '任务正文不能为空。')];
    }
    const task = args.task.trim();
    if (task.length === 0) {
      return [toolError('missing_task', '任务正文不能为空。')];
    }
    if (Array.from(task).length > CODE_TASK_MAX_CHARS) {
      return [toolError('task_too_long', `任务正文不能超过 ${CODE_TASK_MAX_CHARS} 字。`)];
    }

    let repo: CodeRepo | undefined;
    if (args.repo !== undefined) {
      if (typeof args.repo !== 'string' || !isCodeRepo(args.repo)) {
        return [toolError('invalid_target', 'repo 参数不合法。')];
      }
      repo = args.repo;
    }

    let session: string | undefined;
    if (args.session !== undefined) {
      if (
        typeof args.session !== 'string' ||
        args.session.trim().length === 0 ||
        !isSafeSessionText(args.session.trim(), CODE_SESSION_TITLE_MAX_CHARS)
      ) {
        return [toolError('invalid_target', 'session 参数不合法。')];
      }
      session = args.session.trim();
    }

    let workspace: string | undefined;
    if (args.workspace !== undefined) {
      if (
        typeof args.workspace !== 'string' ||
        args.workspace.trim().length === 0 ||
        !isSafeSessionText(
          args.workspace.trim(),
          CODE_SESSION_WORKSPACE_MAX_CHARS,
        )
      ) {
        return [toolError('invalid_target', 'workspace 参数不合法。')];
      }
      workspace = args.workspace.trim();
    }

    let newSession: boolean | undefined;
    if (args.newSession !== undefined) {
      if (typeof args.newSession !== 'boolean') {
        return [toolError('invalid_arguments', 'newSession 必须是 boolean。')];
      }
      newSession = args.newSession;
    }

    if (repo === undefined && session === undefined && workspace === undefined) {
      return [
        toolError(
          'missing_target',
          '请提供 repo、workspace 或 session 之一；不确定会话时先调用 code_sessions。',
        ),
      ];
    }

    return this.submitSubmission(
      requestId,
      {
        ...(repo === undefined ? {} : { repo }),
        ...(session === undefined ? {} : { session }),
        ...(workspace === undefined ? {} : { workspace }),
        ...(newSession === undefined ? {} : { newSession }),
      },
      task,
      'tool',
    );
  }

  private validToolRequestId(requestId: string): boolean {
    return (
      typeof requestId === 'string' &&
      requestId.length > 0 &&
      Array.from(requestId).length <= TOOL_REQUEST_ID_MAX_CHARS &&
      !/[\u0000-\u001f\u007f-\u009f]/.test(requestId)
    );
  }

  private validToolSource(input: CodeToolCallInput): boolean {
    if (input.source === undefined && input.senderQQ === undefined) {
      return this.ownerQQ > 0;
    }
    if (input.source === undefined || input.senderQQ === undefined) return false;
    return (
      input.source.kind === 'private' &&
      input.source.id === this.ownerId &&
      input.senderQQ === this.ownerId &&
      this.ownerQQ !== 0
    );
  }

  private async resolveToolTargetLabel(
    record: CodeTaskRecord,
    target: SubmissionTarget,
  ): Promise<string> {
    if (target.repo !== undefined && target.session === undefined && target.workspace === undefined) {
      return this.recordTargetLabel(record);
    }

    const workspace = record.workspace ?? target.workspace;
    const sessionId = record.sessionId ?? target.sessionId;
    if (sessionId !== null && sessionId !== undefined) {
      const title = await this.lookupSessionTitle(sessionId, target.session);
      if (title !== null) return `会话《${titleLabel(title)}》`;
    }
    if (workspace !== null && workspace !== undefined && workspace.trim().length > 0) {
      return `工作区 ${workspaceLabel(workspace)}`;
    }
    if (sessionId !== null && sessionId !== undefined) {
      return `会话 ${shortSessionId(sessionId)}`;
    }
    if (target.session !== undefined) {
      return `会话 ${titleLabel(target.session)}`;
    }
    return this.recordTargetLabel(record);
  }

  private recordTargetLabel(record: CodeTaskRecord): string {
    if (record.repo !== 'dsh-session' && record.mode !== 'resume') {
      return record.repo;
    }
    if (record.workspace !== null && record.workspace !== undefined) {
      return `工作区 ${workspaceLabel(record.workspace)}`;
    }
    if (record.sessionId !== null && record.sessionId !== undefined) {
      return `会话 ${shortSessionId(record.sessionId)}`;
    }
    return 'DSH 会话';
  }

  private async lookupSessionTitle(
    sessionId: string,
    query?: string,
  ): Promise<string | null> {
    try {
      const sessions = await this.bridge.listSessions(
        query !== undefined && query.trim().length > 0 ? query.trim() : sessionId,
        20,
      );
      const match =
        sessions.find((session) => session.sessionId === sessionId) ??
        sessions.find(
          (session) => query !== undefined && session.title === query,
        );
      return match ? match.title : null;
    } catch {
      return null;
    }
  }

  private sessionListErrorMessage(err: unknown): string {
    if (!(err instanceof CodeBridgeError)) return '会话列表暂时不可用。';
    switch (err.code) {
      case 'offline':
        return '代码桥离线，无法获取会话列表。';
      case 'unauthorized':
        return '代码桥鉴权失败，无法获取会话列表。';
      case 'timeout':
        return '代码桥响应超时，无法获取会话列表。';
      case 'queue_full':
        return '代码桥忙碌，暂时无法获取会话列表。';
      case 'response_invalid':
        return '代码桥会话列表响应异常。';
      default:
        return '代码桥返回错误，无法获取会话列表。';
    }
  }

  private async toolSubmitErrorMessages(err: unknown): Promise<string[]> {
    const base = this.submitErrorMessage(err);
    if (
      !(err instanceof CodeBridgeError) ||
      !CANDIDATE_ERROR_CODES.has(err.code)
    ) {
      return [base];
    }
    const candidates = await this.listSessionsMessage();
    return [clip(`${base}\n\n${candidates[0] ?? ''}`, TOOL_RESULT_MAX_CHARS)];
  }

  private async performPoll(): Promise<void> {
    if (this.stopping) return;

    const active = this.store
      .list()
      .filter((task) => ACTIVE_STATUSES.has(task.status))
      .sort((left, right) => left.submittedAt - right.submittedAt);

    for (const record of active) {
      if (this.stopping) return;
      let bridgeTask: CodeBridgeTask;
      try {
        bridgeTask = await this.bridge.get(record.taskId);
      } catch (err) {
        if (err instanceof CodeBridgeError && err.code === 'not_found') {
          const missing: CodeTaskRecord = {
            ...record,
            status: 'failed',
            error: 'bridge task not found',
            updatedAt: this.now(),
            finishedAt: this.now(),
            notificationStatus: 'pending',
          };
          this.persistPollUpdate(missing);
        } else {
          this.safeWarn('code 任务轮询失败');
        }
        continue;
      }

      if (
        bridgeTask.taskId !== record.taskId ||
        bridgeTask.requestId !== record.requestId ||
        bridgeTask.repo !== record.repo
      ) {
        this.safeWarn('code 任务轮询响应与本地任务不匹配');
        continue;
      }
      this.persistPollUpdate(this.mergePolledTask(record, bridgeTask));
    }

    const pending = this.store
      .list()
      .filter(
        (task) =>
          isTerminal(task.status) && task.notificationStatus === 'pending',
      )
      .sort((left, right) => left.updatedAt - right.updatedAt);

    for (const record of pending) {
      if (this.stopping) return;
      await this.sendTerminalNotification(record);
    }
  }

  private mergePolledTask(
    record: CodeTaskRecord,
    task: CodeBridgeTask,
  ): CodeTaskRecord {
    const metadata = this.taskMetadata(task);
    return {
      ...record,
      ...metadata,
      updatedAt: Math.max(record.updatedAt, metadata.updatedAt),
      cancelRequestedAt: record.cancelRequestedAt ?? metadata.cancelRequestedAt,
      notificationStatus:
        !isTerminal(record.status) &&
        isTerminal(task.status) &&
        record.notificationStatus !== 'sent'
          ? 'pending'
          : record.notificationStatus,
    };
  }

  private taskMetadata(task: CodeBridgeTask): Pick<
    CodeTaskRecord,
    | 'status'
    | 'updatedAt'
    | 'startedAt'
    | 'finishedAt'
    | 'worktree'
    | 'changedFiles'
    | 'diffStat'
    | 'summary'
    | 'error'
    | 'cancelRequestedAt'
    | 'sessionId'
    | 'workspace'
    | 'mode'
  > {
    const metadata: Pick<
      CodeTaskRecord,
      | 'status'
      | 'updatedAt'
      | 'startedAt'
      | 'finishedAt'
      | 'worktree'
      | 'changedFiles'
      | 'diffStat'
      | 'summary'
      | 'error'
      | 'cancelRequestedAt'
      | 'sessionId'
      | 'workspace'
      | 'mode'
    > = {
      status: task.status,
      updatedAt: task.updatedAt,
      startedAt: task.startedAt,
      finishedAt: task.finishedAt,
      worktree: clipNullable(task.worktree, WORKTREE_MAX_CHARS),
      changedFiles: task.changedFiles
        .slice(0, 200)
        .map((path) => clip(path, WORKTREE_MAX_CHARS)),
      diffStat: clipNullable(task.diffStat, DIFF_STAT_MAX_CHARS),
      summary: clipNullable(task.summary, this.summaryMaxChars),
      error: clipNullable(task.error, ERROR_MAX_CHARS),
      cancelRequestedAt: task.cancelRequestedAt,
    };
    if (task.sessionId !== undefined) metadata.sessionId = task.sessionId;
    if (task.workspace !== undefined) {
      metadata.workspace = clipNullable(
        task.workspace,
        CODE_SESSION_WORKSPACE_MAX_CHARS,
      );
    }
    if (task.mode !== undefined) metadata.mode = task.mode;
    return metadata;
  }

  private recordFromTask(task: CodeBridgeTask, taskLength: number): CodeTaskRecord {
    return {
      requestId: task.requestId,
      taskId: task.taskId,
      repo: task.repo,
      taskLength,
      submittedAt: task.createdAt,
      notificationStatus: 'pending',
      notifiedAt: null,
      ...this.taskMetadata(task),
    };
  }

  private persistPollUpdate(record: CodeTaskRecord): void {
    try {
      this.store.upsert(record);
    } catch {
      this.safeWarn('code-tasks 状态保存失败');
    }
  }

  private async sendTerminalNotification(record: CodeTaskRecord): Promise<void> {
    const message = this.terminalMessage(record);
    let result: SendResult;
    try {
      result = await this.sender.send(
        { kind: 'private', id: this.ownerId },
        [message],
        { reason: 'proactive' },
      );
    } catch {
      this.markNotification(record, 'ambiguous', null);
      return;
    }

    const outcome = notificationOutcome(result);
    if (outcome === 'sent') {
      this.markNotification(record, 'sent', this.now());
    } else if (outcome === 'pending') {
      this.safeWarn('code 任务终态通知未送达，下轮重试');
    } else {
      this.markNotification(record, 'ambiguous', null);
    }
  }

  private markNotification(
    record: CodeTaskRecord,
    status: CodeTaskNotificationStatus,
    notifiedAt: number | null,
  ): void {
    this.persistPollUpdate({
      ...record,
      notificationStatus: status,
      notifiedAt,
    });
  }

  private terminalMessage(record: CodeTaskRecord): string {
    const lines = [
      `代码任务 ${record.taskId}（${this.recordTargetLabel(record)}）状态：${record.status}`,
    ];
    const summary = clipNullable(record.summary, this.summaryMaxChars);
    const rawError = clipNullable(record.error, ERROR_MAX_CHARS);
    const error = rawError === null ? null : this.taskErrorLabel(rawError);
    const diffStat = clipNullable(record.diffStat, DIFF_STAT_MAX_CHARS);
    const worktree = clipNullable(record.worktree, WORKTREE_MAX_CHARS);
    if (summary) lines.push(`摘要：${summary}`);
    if (error) lines.push(`错误：${error}`);
    if (record.changedFiles.length > 0) {
      const diff = diffStat ? `，${diffStat}` : '';
      lines.push(`变更：${record.changedFiles.length} 个文件${diff}`);
    } else if (diffStat) {
      lines.push(`变更：${diffStat}`);
    }
    if (worktree) lines.push(`工作树：${worktree}`);
    return lines.join('\n');
  }

  private taskErrorLabel(error: string): string {
    switch (error) {
      case 'session_preset_incompatible':
        return `该会话由桌面端预设创建，headless 无法恢复（${error}）`;
      case 'session_subagent':
        return `该会话是子代理会话，不能直接恢复（${error}）`;
      case 'session_invalid':
        return `该会话缺少有效的工作目录，无法恢复（${error}）`;
      case 'session_cwd_mismatch':
        return `该会话的工作目录与目标不一致（${error}）`;
      case 'permission_preset_invalid':
        return `该会话的权限预设不可用（${error}）`;
      default: {
        const match = /^dsh_exit_code_(-?\d+)$/.exec(error);
        return match ? `DSH 执行失败（退出码 ${match[1]}）` : error;
      }
    }
  }

  private safeWarn(message: string): void {
    this.onWarn(message);
  }
}
