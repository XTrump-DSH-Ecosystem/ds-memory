const SECRET_TOKEN_RE = /sk-[A-Za-z0-9_-]{8,}/g;
const BEARER_RE = /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const REMOTE_URL_SPLIT_RE =
  /((?:https?|ftps?|wss?):\/\/[^\s"'`<>，。；：！？、（）【】《》]+)/i;
const FILE_URL_RE = /\bfile:\/\/[^\s"'`<>，。；：！？、（）【】《》]+/gi;
const QUOTED_PATH_RE =
  /(["'`])([A-Za-z]:[\\/][^\r\n]*|\\\\[^\r\n]*|\/(?!\/)[^\r\n]*)\1/g;
const UNQUOTED_PATH_RE =
  /\b[A-Za-z]:[\\/][^\r\n]*|\\\\[^\r\n]*|(?<![\w/.])\/(?!\/)[^\r\n]*/g;
const TRAILING_PATH_PUNCTUATION = /[.,;:!?)}\]，。；：！？、]+$/;
const PATH_MARKER = '[REDACTED_PATH]';

/**
 * 凭据脱敏：日志、错误消息、可选的回显文本都必须先过这里。
 * 既按环境变量名（*KEY / *TOKEN / *SECRET）替换，也兜底替换常见 token 形态。
 */
export function redact(input: string): string {
  let out = input;

  for (const [name, value] of Object.entries(process.env)) {
    if (!value || value.length < 8) continue;
    if (!/(KEY|TOKEN|SECRET)/i.test(name)) continue;
    out = out.split(value).join('[REDACTED]');
  }

  out = out.replace(SECRET_TOKEN_RE, '[REDACTED]');
  out = out.replace(BEARER_RE, 'Bearer [REDACTED]');
  return out;
}

/** 把任意错误转成可安全打印的一行文本。 */
export function describeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return redact(message);
}

/**
 * 路径脱敏：把绝对路径片段替换为 `[REDACTED_PATH]`，其余文本原样保留。
 *
 * 覆盖：
 * - Windows 盘符绝对路径：`C:\...`、`C:/...`；
 * - UNC 路径：`\\server\share\...`；
 * - POSIX 绝对路径：`/tmp/...`、`/var/...`。
 *
 * `http(s)`/`ftp`/`ws(s)` URL 会先整体保护，避免把远程 URL 路径误判为本地路径；
 * `file://` 本地文件 URL 则整体替换为脱敏标记。
 * 引号内的路径按同种引号贪婪匹配到本行最后一个同种引号，允许路径内部出现撇号等
 * 同种或异种引号，只替换引号内内容。若后续引号字段被一并吞掉，这是安全取舍。
 * 安全优先：未加引号的绝对路径一旦命中，会从路径起点一直替换到行尾/CR/LF，
 * 不保留其后的日志上下文（尾部标点尽量保留）。因此 `/health` 这类普通斜杠 token
 * 也可能被整体脱敏；这是有意取舍，不要回退到遇空格/引号即停止。
 * 该函数独立于 `redact()`，由调用方显式组合使用。
 */
export function redactPaths(input: string): string {
  if (input.length === 0) return input;

  const parts = input.split(REMOTE_URL_SPLIT_RE);
  for (let index = 0; index < parts.length; index += 2) {
    parts[index] = redactPathsOutsideUrl(parts[index]!);
  }
  return parts.join('');
}

function redactPathsOutsideUrl(text: string): string {
  let out = text.replace(FILE_URL_RE, PATH_MARKER);
  out = out.replace(
    QUOTED_PATH_RE,
    (_match, quote: string) => `${quote}${PATH_MARKER}${quote}`,
  );
  out = out.replace(UNQUOTED_PATH_RE, (match) => {
    const suffix = match.match(TRAILING_PATH_PUNCTUATION)?.[0] ?? '';
    return `${PATH_MARKER}${suffix}`;
  });
  return out;
}
