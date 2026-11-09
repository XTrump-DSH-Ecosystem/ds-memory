/** L0 原文单条文本上限（字符数），超出会截断并打标记。 */
export const TEXT_LIMIT = 4000;

/** 截断标记由 store 追加在文本末尾，便于 tail 时一眼看出。 */
export const TRUNCATE_MARKER = '…[truncated]';

/** 命令前缀兼容：把全角感叹号 ！ 归一化为半角 !，其余内容不变。 */
export function normalizeCommandPrefix(text: string): string {
  return text.startsWith('！') ? `!${text.slice(1)}` : text;
}

/**
 * 按「字符」截断（用 Array.from 避免把 emoji 的代理对切一半），
 * 超出上限时追加标记。返回值永远不超过 limit + 标记长度。
 */
export function truncateText(text: string, limit: number = TEXT_LIMIT): string {
  if (text.length <= limit) return text;

  const chars = Array.from(text);
  if (chars.length <= limit) return text;

  return chars.slice(0, limit).join('') + TRUNCATE_MARKER;
}
