export {
  createAgentWebToolRuntime,
  type AgentWebToolRuntime,
  type AgentWebToolRuntimeOptions,
  type WebToolCall,
  type WebToolExecutionResult,
  type WebToolLogEvent,
  type WebToolLogger,
  type WebToolSpec,
} from './tools.ts';

export {
  WEB_TOOL_ERROR_CODES,
  WEB_TOOL_ERROR_MESSAGES,
  WebToolError,
  errorCodeOf,
  type WebToolErrorCode,
} from './errors.ts';

export {
  WEB_TOOL_MAX_RESULT_CHARS,
  WEB_TOOL_MAX_ROUND_CHARS,
  WEB_TOOL_ERROR_RESERVE_CHARS,
  WEB_TOOL_MIN_RESULT_BUDGET,
  WEB_TOOL_TRUNCATION_MARKER,
  countChars,
  truncateToChars,
  type TruncateResult,
} from './budget.ts';

export {
  WEB_SEARCH_ENDPOINT_FILENAME,
  WEB_SEARCH_HOST,
  WEB_SEARCH_VERSION,
  isProcessAlive,
  parseWebSearchEndpoint,
  readWebSearchEndpoint,
  webSearchEndpointPath,
  type WebSearchEndpoint,
  type WebSearchEndpointInvalidReason,
  type WebSearchEndpointParseOptions,
  type WebSearchEndpointValidation,
} from './endpoint.ts';

export {
  WEB_URL_ALLOWLIST_MAX_ENTRIES,
  WEB_URL_ALLOWLIST_TTL_MS,
  WebUrlAllowlist,
  processWebUrlAllowlist,
  type WebUrlAllowlistOptions,
} from './allowlist.ts';

export {
  classifyIpAddress,
  normalizeFetchableUrl,
  validateWebFetchUrl,
  type IpClassification,
  type LookupFn,
  type ResolvedAddress,
  type UrlPolicyOptions,
  type UrlPolicyRejectReason,
  type UrlPolicyResult,
} from './url-policy.ts';

export {
  OpenWebSearchClient,
  WEB_FETCH_TIMEOUT_MS,
  WEB_ROUND_TIMEOUT_MS,
  WEB_SEARCH_TIMEOUT_MS,
  WEB_STATUS_TIMEOUT_MS,
  type WebClientTimeouts,
  type WebFetchData,
  type WebSearchClientLike,
  type WebSearchClientOptions,
  type WebSearchData,
  type WebSearchResultItem,
} from './client.ts';

export {
  DEEPSEEK_SEARCH_BASE_URL,
  DEEPSEEK_SEARCH_TIMEOUT_MS,
  DeepSeekSearchClient,
  FallbackWebSearchClient,
  type DeepSeekSearchClientOptions,
  type FallbackWebSearchClientOptions,
} from './deepseek.ts';

export type { DeepSeekSearchOptions } from './tools.ts';

export {
  UNTRUSTED_BEGIN_PREFIX,
  UNTRUSTED_END_PREFIX,
  buildUntrustedWebContent,
  createBoundaryNonce,
  escapeBoundaryMarkers,
  escapeBoundaryPrefixes,
  normalizeBoundaryNonce,
  sanitizeUntrustedText,
  type UntrustedWebContentInput,
  type UntrustedWebContentResult,
} from './untrusted.ts';
