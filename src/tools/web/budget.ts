export const WEB_TOOL_MAX_RESULT_CHARS = 12_000;
export const WEB_TOOL_MAX_ROUND_CHARS = 24_000;
export const WEB_TOOL_MIN_RESULT_BUDGET = 256;
export const WEB_TOOL_ERROR_RESERVE_CHARS = 256;
export const WEB_TOOL_TRUNCATION_MARKER = '…[truncated]';

export function countChars(text: string): number {
  return Array.from(text).length;
}

export interface TruncateResult {
  text: string;
  truncated: boolean;
}

/** 按 Unicode 码点截断，避免把代理对切成半个字符；结果长度不超过 limit。 */
export function truncateToChars(
  text: string,
  limit: number,
  marker: string = WEB_TOOL_TRUNCATION_MARKER,
): TruncateResult {
  if (!Number.isFinite(limit) || limit <= 0) {
    return { text: '', truncated: text.length > 0 };
  }

  const chars = Array.from(text);
  if (chars.length <= limit) return { text, truncated: false };

  const markerChars = Array.from(marker);
  if (limit <= markerChars.length) {
    return { text: chars.slice(0, limit).join(''), truncated: true };
  }

  return {
    text: chars.slice(0, limit - markerChars.length).join('') + marker,
    truncated: true,
  };
}
