/**
 * `code` 控制消息的纯解析层。
 *
 * 只识别绝对行首、ASCII 小写 `code`，且第 4 个字符为空格/制表符/换行
 * （含 CRLF 的 `\r`）或文本恰为 `code`。`codex`、`Code`、前置空白均不是
 * code 控制消息。
 */

export const CODE_TASK_REPOS = [
  'ds-memory',
  'martilyric',
  'qq-gateway',
  'xtds',
  'xtds-assistant-dsh',
] as const;

export type CodeRepo = (typeof CODE_TASK_REPOS)[number];

export const CODE_TASK_MAX_CHARS = 4000;
export const CODE_SESSIONS_QUERY_MAX_CHARS = 100;

export type CodeCommandUsageReason =
  | 'not_code'
  | 'missing_repo'
  | 'unknown_repo'
  | 'empty_task'
  | 'task_too_long'
  | 'missing_task_id'
  | 'sessions_query_too_long'
  | 'sessions_query_multiline';

export type CodeCommand =
  | { kind: 'submit'; repo: CodeRepo; task: string }
  | { kind: 'sessions'; query: string }
  | { kind: 'status' }
  | { kind: 'cancel'; taskId: string }
  | { kind: 'usage'; reason: CodeCommandUsageReason };

const REPO_SET: ReadonlySet<string> = new Set(CODE_TASK_REPOS);
const SEPARATOR_RE = /[ \t\r\n]/;
const SEPARATORS_RE = /^[ \t\r\n]+/;
const TOKEN_END_RE = /[ \t\r\n]/;

export function isCodeRepo(value: string): value is CodeRepo {
  return REPO_SET.has(value);
}

/**
 * 判断文本是否为 code 控制消息。
 *
 * 必须从索引 0 开始，不能先 trim；这保证“普通消息里提到 code”以及
 * 前置空格的消息不会被提升成控制指令。
 */
export function isCodeCommandText(text: string): boolean {
  if (!text.startsWith('code')) return false;
  if (text.length === 4) return true;
  return SEPARATOR_RE.test(text.charAt(4));
}

function withoutLeadingSeparators(text: string): string {
  return text.replace(SEPARATORS_RE, '');
}

/**
 * QQ 的 `@` 消息段与后续文本段之间通常带一个前导空格。
 * 仅群聊 @/引用路径可用此函数归一化命令候选；私聊不得调用。
 */
export function stripMentionSeparators(text: string): string {
  return withoutLeadingSeparators(text);
}

function firstToken(text: string): { token: string; rest: string } {
  const tokenEnd = text.search(TOKEN_END_RE);
  if (tokenEnd < 0) return { token: text, rest: '' };
  return {
    token: text.slice(0, tokenEnd),
    rest: withoutLeadingSeparators(text.slice(tokenEnd)),
  };
}

function taskLength(text: string): number {
  return Array.from(text).length;
}

/** 解析 code 控制消息；非 code 文本或非法参数返回 usage。 */
export function parseCodeCommand(text: string): CodeCommand {
  if (!isCodeCommandText(text)) return { kind: 'usage', reason: 'not_code' };
  if (text.length === 4) return { kind: 'usage', reason: 'missing_repo' };

  const body = withoutLeadingSeparators(text.slice(4));
  if (body.length === 0) return { kind: 'usage', reason: 'missing_repo' };

  const { token: head, rest } = firstToken(body);
  if (head === 'status') {
    return rest.length === 0 ? { kind: 'status' } : { kind: 'usage', reason: 'unknown_repo' };
  }
  if (head === 'cancel') {
    const taskId = rest.trim();
    if (taskId.length === 0 || /[ \t\r\n]/.test(taskId)) {
      return { kind: 'usage', reason: 'missing_task_id' };
    }
    return { kind: 'cancel', taskId };
  }
  if (head === 'sessions') {
    const query = rest.trim();
    if (/[\r\n]/.test(query)) {
      return { kind: 'usage', reason: 'sessions_query_multiline' };
    }
    if (taskLength(query) > CODE_SESSIONS_QUERY_MAX_CHARS) {
      return { kind: 'usage', reason: 'sessions_query_too_long' };
    }
    return { kind: 'sessions', query };
  }
  if (!isCodeRepo(head)) return { kind: 'usage', reason: 'unknown_repo' };

  const task = rest.trim();
  if (task.length === 0) return { kind: 'usage', reason: 'empty_task' };
  if (taskLength(task) > CODE_TASK_MAX_CHARS) {
    return { kind: 'usage', reason: 'task_too_long' };
  }
  return { kind: 'submit', repo: head, task };
}
