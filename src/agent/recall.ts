import {
  INJECTION_HEADER,
  formatTime,
  type MemoryChunk,
  type Retriever,
} from '../memory/retriever/types.ts';

/**
 * 触发式召回（ADR-D3）：
 * - trigger=auto 时，只有命中回忆词正则才检索；日常闲聊零检索开销
 * - trigger=off 时完全不自动检索（!回忆 命令仍可用）
 */
export const RECALL_TRIGGER_RE = /(记得|上次|之前|以前|说过|忘|聊过|还记|那时候|当时)/;

export function isRecallTriggered(text: string, trigger: 'auto' | 'off'): boolean {
  if (trigger === 'off') return false;
  return RECALL_TRIGGER_RE.test(text);
}

export interface RecallInput {
  query: string;
  retriever: Retriever;
  sessionKey: string;
  budgetChars: number;
  budgetItems: number;
}

/**
 * 检索并按预算组装本轮动态段前缀（【回忆】…\n\n）。
 * 返回空串表示没有命中或预算放不下。
 */
export async function buildRecallPrefix(input: RecallInput): Promise<string> {
  const hits = await input.retriever.search(input.query, {
    sessionKey: input.sessionKey,
    limit: input.budgetItems,
  });
  if (hits.length === 0) return '';

  const prefixHeader = '【回忆】';
  // 预留：前缀头 + 换行 + 框定标题 + 结尾两个换行。
  let remaining =
    input.budgetChars - charLength(prefixHeader) - charLength(INJECTION_HEADER) - 4;

  const lines: string[] = [];
  for (const [index, hit] of hits.entries()) {
    const label = `${index + 1}. ${formatTime(hit.at)} ${hit.who}：`;
    const lineChars = charLength(label) + charLength(hit.text);

    if (lineChars <= remaining) {
      lines.push(`${label}${hit.text}`);
      remaining -= lineChars + 1; // 行间换行
      continue;
    }

    // 第一条就放不下时，截断文本凑进预算；后续条目直接放弃。
    if (lines.length === 0) {
      // 留 1 个字符给省略号，保证整块不超过 budgetChars。
      const available = remaining - charLength(label) - 1;
      if (available > 10) {
        lines.push(`${label}${sliceChars(hit.text, available)}…`);
      }
    }
    break;
  }

  if (lines.length === 0) return '';
  return `${prefixHeader}\n${INJECTION_HEADER}\n${lines.join('\n')}\n\n`;
}

function charLength(text: string): number {
  return Array.from(text).length;
}

function sliceChars(text: string, limit: number): string {
  return Array.from(text).slice(0, limit).join('');
}

export type { MemoryChunk };
