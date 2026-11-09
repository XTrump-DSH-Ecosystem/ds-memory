export const WEB_TOOL_ERROR_CODES = [
  'web_endpoint_unavailable',
  'web_identity_mismatch',
  'web_daemon_unavailable',
  'web_timeout',
  'web_upstream_error',
  'web_bad_response',
  'web_url_not_allowed',
  'web_url_not_allowlisted',
  'web_budget_exceeded',
  'web_invalid_arguments',
  'web_unknown_tool',
  'web_aborted',
  'web_search_failed',
  'web_fetch_failed',
  'web_internal_error',
] as const;

export type WebToolErrorCode = (typeof WEB_TOOL_ERROR_CODES)[number];

/** 工具错误对外只暴露固定枚举，绝不拼接上游消息、URL 或正文。 */
export const WEB_TOOL_ERROR_MESSAGES: Readonly<Record<WebToolErrorCode, string>> = {
  web_endpoint_unavailable: '联网服务端点不可用。',
  web_identity_mismatch: '联网服务身份校验失败。',
  web_daemon_unavailable: '无法连接联网服务。',
  web_timeout: '联网请求超时。',
  web_upstream_error: '联网服务返回错误。',
  web_bad_response: '联网服务响应格式无效。',
  web_url_not_allowed: '该 URL 不符合抓取安全策略。',
  web_url_not_allowlisted: '只能抓取本会话搜索结果中的 URL。',
  web_budget_exceeded: '本轮联网结果已达到字符上限。',
  web_invalid_arguments: '工具参数无效。',
  web_unknown_tool: '未知工具。',
  web_aborted: '联网请求已取消。',
  web_search_failed: '搜索失败。',
  web_fetch_failed: '网页抓取失败。',
  web_internal_error: '联网工具内部错误。',
};

export class WebToolError extends Error {
  readonly code: WebToolErrorCode;

  constructor(code: WebToolErrorCode) {
    super(WEB_TOOL_ERROR_MESSAGES[code]);
    this.name = 'WebToolError';
    this.code = code;
  }
}

export function errorCodeOf(error: unknown): WebToolErrorCode {
  if (error instanceof WebToolError) return error.code;
  if (error instanceof Error) {
    if (error.name === 'AbortError') return 'web_aborted';
    if (error.name === 'TimeoutError') return 'web_timeout';
  }
  return 'web_internal_error';
}
