import {
  PERSONA_CARD_NICKNAME_LIMIT,
  PERSONA_CARD_TEXT_LIMIT,
  type PersonaCardStore,
} from '../agent/persona-card.ts';
import type { FactsStore } from '../memory/facts.ts';
import { formatInjection } from '../memory/retriever/types.ts';
import type { Retriever } from '../memory/retriever/types.ts';
import { isNicknamePreferenceText, type SelfNoteStore } from '../memory/selfnote.ts';
import { normalizeCommandPrefix } from '../util/string.ts';

type PersonaCardCommands = Pick<
  PersonaCardStore,
  'read' | 'setNickname' | 'setText' | 'clearText'
>;

export interface QqMemoryCommandOptions {
  sessionKey: string;
  facts: Pick<FactsStore, 'upsert' | 'archiveMatching'>;
  selfNotes: Pick<SelfNoteStore, 'upsert' | 'archiveMatching'>;
  retriever: Pick<Retriever, 'search'>;
  recallBudgetItems: number;
  personaCard: PersonaCardCommands;
  onPersonaCardChanged?: () => void;
  consolidate?: () => Promise<{
    ok: boolean;
    reason?: string;
    facts?: number;
    selfNotes?: number;
  }>;
}

export type QqMemoryCommandResult =
  | { handled: false }
  | { handled: true; messages: string[] };

type ParsedCommand = {
  kind: '记' | 'note' | '回忆' | '整理' | '称呼' | '人格' | '忘';
  body: string;
};

/**
 * QQ 管理命令（owner-only）：只处理明确的控制命令，未知 ! 文本交回模型。
 * 命令正文不允许用模型解释，避免把群聊内容提升成控制指令。
 */
export function parseQqMemoryCommand(text: string): ParsedCommand | null {
  const normalized = normalizeCommandPrefix(text.trim());
  const match = /^!(记|note|回忆|整理|称呼|人格|忘)(?:\s+([\s\S]*))?$/.exec(normalized);
  if (!match) return null;
  return {
    kind: match[1] as ParsedCommand['kind'],
    body: (match[2] ?? '').trim(),
  };
}

export async function runQqMemoryCommand(
  text: string,
  options: QqMemoryCommandOptions,
): Promise<QqMemoryCommandResult> {
  const parsed = parseQqMemoryCommand(text);
  if (!parsed) return { handled: false };

  if (parsed.kind === '记') {
    if (parsed.body.length === 0) {
      return { handled: true, messages: ['用法：!记 <一句话>'] };
    }
    const result = options.facts.upsert(options.sessionKey, parsed.body, 'misc');
    return {
      handled: true,
      messages: [
        result
          ? `${result.created ? '已记住' : '复习一次'}：${result.record.text}`
          : '事实写入失败（历史记录未落盘）',
      ],
    };
  }

  if (parsed.kind === 'note') {
    if (parsed.body.length === 0) {
      return { handled: true, messages: ['用法：!note <一句话>'] };
    }
    const note = options.selfNotes.upsert(options.sessionKey, parsed.body);
    return {
      handled: true,
      messages: [note ? `已写下自认知：${note.text}` : 'selfNote 写入失败'],
    };
  }

  if (parsed.kind === '整理') {
    if (parsed.body.length > 0) {
      return { handled: true, messages: ['用法：!整理（不需要参数）'] };
    }
    if (!options.consolidate) {
      return { handled: true, messages: ['整理命令未接线'] };
    }
    const result = await options.consolidate();
    if (!result.ok) {
      return { handled: true, messages: [`整理未完成：${result.reason ?? '未知原因'}`] };
    }
    return {
      handled: true,
      messages: [
        `整理完成：事实 ${result.facts ?? 0} 条，自认知 ${result.selfNotes ?? 0} 条，摘要已更新`,
      ],
    };
  }

  if (parsed.kind === '称呼') {
    const result = options.personaCard.setNickname(parsed.body);
    if (!result.ok) {
      if (result.error === 'empty') {
        return { handled: true, messages: ['用法：!称呼 <称呼>'] };
      }
      if (result.error === 'too_long') {
        return {
          handled: true,
          messages: [
            `称呼过长：最多 ${PERSONA_CARD_NICKNAME_LIMIT} 字（当前 ${result.length} 字）`,
          ],
        };
      }
      return {
        handled: true,
        messages: [`称呼写入失败（人格卡未更新）：${result.reason}`],
      };
    }

    // 只归档代码自己生成过的旧称呼偏好。自由文本里的身份拒绝无法可靠分类，
    // 为避免把项目/技术/转述事实误归档，身份类旧记忆交给 owner 的 !忘 显式处理。
    const archived = options.selfNotes.archiveMatching(
      options.sessionKey,
      (record) => isNicknamePreferenceText(record.text),
    );
    options.onPersonaCardChanged?.();

    return {
      handled: true,
      messages: [
        `已设置称呼「${result.value}」；下一轮生效。归档旧称呼偏好 ${archived} 条。`,
      ],
    };
  }

  if (parsed.kind === '人格') {
    if (parsed.body.length === 0) {
      const card = options.personaCard.read();
      if (card.nickname.length === 0 && card.text.length === 0) {
        return {
          handled: true,
          messages: ['用法：!人格（查看）/ !人格 <文本> / !人格 清空'],
        };
      }
      return {
        handled: true,
        messages: [
          [
            '当前人格卡：',
            `称呼：${card.nickname.length > 0 ? card.nickname : '（未设置）'}`,
            '卡片：',
            card.text.length > 0 ? card.text : '（空）',
          ].join('\n'),
        ],
      };
    }

    if (parsed.body === '清空') {
      const result = options.personaCard.clearText();
      if (!result.ok) {
        return {
          handled: true,
          messages: [`人格卡清空失败（未更新）：${result.reason}`],
        };
      }
      options.onPersonaCardChanged?.();
      return {
        handled: true,
        messages: ['人格卡已清空（称呼保留）；下一轮生效。'],
      };
    }

    const result = options.personaCard.setText(parsed.body);
    if (!result.ok) {
      if (result.error === 'too_long') {
        return {
          handled: true,
          messages: [
            `人格卡过长：最多 ${PERSONA_CARD_TEXT_LIMIT} 字（当前 ${result.length} 字）`,
          ],
        };
      }
      return {
        handled: true,
        messages: [`人格卡写入失败（未更新）：${result.reason}`],
      };
    }

    options.onPersonaCardChanged?.();
    return {
      handled: true,
      messages: [`人格卡已更新（${result.length} 字）；下一轮生效。`],
    };
  }

  if (parsed.kind === '忘') {
    if (parsed.body.length === 0) {
      return { handled: true, messages: ['用法：!忘 <关键词>'] };
    }
    const keyword = parsed.body;
    const archivedFacts = options.facts.archiveMatching(options.sessionKey, (record) =>
      record.text.includes(keyword),
    );
    const archivedNotes = options.selfNotes.archiveMatching(options.sessionKey, (record) =>
      record.text.includes(keyword),
    );
    return {
      handled: true,
      messages: [
        `已忘掉相关记忆：事实 ${archivedFacts} 条，自认知 ${archivedNotes} 条（只归档未删除，原文仍在磁盘）。`,
      ],
    };
  }

  if (parsed.body.length === 0) {
    return { handled: true, messages: ['用法：!回忆 <关键词>'] };
  }

  const hits = await options.retriever.search(parsed.body, {
    sessionKey: options.sessionKey,
    limit: options.recallBudgetItems,
  });
  return {
    handled: true,
    messages: [hits.length > 0 ? formatInjection(hits) : '没有检索到相关记忆。'],
  };
}
