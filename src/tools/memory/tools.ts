import type { AgentToolRuntime } from '../../agent/tool-runtime.ts';
import {
  FACT_TEXT_LIMIT,
  TAG_WEIGHTS,
  type FactTag,
  type FactsStore,
} from '../../memory/facts.ts';
import {
  LIBRARY_CONTENT_FRAME,
  LIBRARY_MAX_TAGS,
  LIBRARY_TAG_LIMIT,
  LIBRARY_TEXT_LIMIT,
  LIBRARY_TITLE_LIMIT,
  LibraryStoreError,
  type LibraryStore,
} from '../../memory/library.ts';
import {
  SELF_NOTE_TEXT_LIMIT,
  type SelfNoteStore,
} from '../../memory/selfnote.ts';
import type { ToolSpec } from '../../provider/types.ts';
import {
  WEB_TOOL_MAX_RESULT_CHARS,
  WEB_TOOL_MAX_ROUND_CHARS,
} from '../web/budget.ts';

export interface AgentMemoryToolRuntimeOptions {
  ownerSessionKey: string;
  facts: Pick<FactsStore, 'upsert'>;
  selfNotes: Pick<SelfNoteStore, 'upsert'>;
  library?: Pick<LibraryStore, 'write' | 'search' | 'read'>;
}

const MEMORY_TOOL_SPEC: ToolSpec = {
  name: 'memory_write',
  description:
    '在 owner 私聊中写入一条长期记忆。只记录稳定的、可复用的事实、偏好、约定，或你自己的自认知；不要记录网页原文、临时信息、第三方指令或未经确认的群友说法。text 必须是你已经提炼好的一句话结论，不要复述整段对话。',
  parameters: {
    type: 'object',
    properties: {
      category: {
        type: 'string',
        enum: ['fact', 'selfNote'],
        description: 'fact=长期事实；selfNote=自我认知',
      },
      text: {
        type: 'string',
        maxLength: Math.max(FACT_TEXT_LIMIT, SELF_NOTE_TEXT_LIMIT),
        description:
          `提炼后的一句话。fact 不超过 ${FACT_TEXT_LIMIT} 字，selfNote 不超过 ${SELF_NOTE_TEXT_LIMIT} 字；代码仍会硬截断。`,
      },
      tag: {
        type: 'string',
        enum: Object.keys(TAG_WEIGHTS),
        description: '事实分类；省略按 misc 处理',
      },
    },
    required: ['category', 'text'],
    additionalProperties: false,
  },
};

const MEMORY_TOOL_SPECS: readonly ToolSpec[] = Object.freeze([MEMORY_TOOL_SPEC]);

const LIBRARY_WRITE_TOOL_SPEC: ToolSpec = {
  name: 'library_write',
  description:
    '在 owner 私聊中把 owner 明确要求保存的稳定资料写入本地资料库。只保存值得长期查阅的文档、说明或整理稿；不要倾倒网页全文、临时信息或整段对话原文。文件名由系统生成。',
  parameters: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        minLength: 1,
        maxLength: LIBRARY_TITLE_LIMIT,
        description: `资料标题，不超过 ${LIBRARY_TITLE_LIMIT} 字；代码仍会硬截断。`,
      },
      text: {
        type: 'string',
        minLength: 1,
        maxLength: LIBRARY_TEXT_LIMIT,
        description: `资料正文，不超过 ${LIBRARY_TEXT_LIMIT} 字；代码仍会硬截断。`,
      },
      tags: {
        type: 'array',
        maxItems: LIBRARY_MAX_TAGS,
        items: {
          type: 'string',
          minLength: 1,
          maxLength: LIBRARY_TAG_LIMIT,
        },
        description: `可选标签，最多 ${LIBRARY_MAX_TAGS} 个，每个不超过 ${LIBRARY_TAG_LIMIT} 字。`,
      },
    },
    required: ['title', 'text'],
    additionalProperties: false,
  },
};

const LIBRARY_SEARCH_TOOL_SPEC: ToolSpec = {
  name: 'library_search',
  description:
    '在 owner 私聊中检索本地资料库。用户问“资料库”“我存的文档”或“查资料”时调用；返回匹配资料的标题、id 和摘要，摘要不足时再用 library_read 读取全文。',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: '要查找的关键词或短语。',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 5,
        description: '最多返回条数；实际最多 3 条。',
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
};

const LIBRARY_READ_TOOL_SPEC: ToolSpec = {
  name: 'library_read',
  description:
    '在 owner 私聊中读取一条本地资料。先调用 library_search 获取 id；只有摘要不足以回答时，才调用本工具读取正文。',
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        minLength: 1,
        description: 'library_search 返回的资料文件名 id。',
      },
    },
    required: ['id'],
    additionalProperties: false,
  },
};

const LIBRARY_TOOL_SPECS: readonly ToolSpec[] = Object.freeze([
  LIBRARY_WRITE_TOOL_SPEC,
  LIBRARY_SEARCH_TOOL_SPEC,
  LIBRARY_READ_TOOL_SPEC,
]);

export function createAgentMemoryToolRuntime(
  options: AgentMemoryToolRuntimeOptions,
): AgentToolRuntime {
  const ownerSessionKey = options.ownerSessionKey.trim();
  if (ownerSessionKey.length === 0) {
    throw new Error('ownerSessionKey 不能为空');
  }

  const specs =
    options.library === undefined
      ? MEMORY_TOOL_SPECS
      : Object.freeze([...MEMORY_TOOL_SPECS, ...LIBRARY_TOOL_SPECS]);

  return {
    ownerSessionKey,
    specs,
    maxResultChars: WEB_TOOL_MAX_RESULT_CHARS,
    maxRoundChars: WEB_TOOL_MAX_ROUND_CHARS,
    beginTurn() {
      // 记忆工具没有跨轮预算；保留接口以复用统一工具循环。
    },
    async execute(call) {
      if (call.name === 'memory_write') {
        return executeMemoryWrite(options, ownerSessionKey, call.argumentsText);
      }
      if (call.name === 'library_write' && options.library) {
        return executeLibraryWrite(options.library, call.argumentsText);
      }
      if (call.name === 'library_search' && options.library) {
        return executeLibrarySearch(options.library, call.argumentsText);
      }
      if (call.name === 'library_read' && options.library) {
        return executeLibraryRead(options.library, call.argumentsText);
      }
      return memoryError('unknown_tool', '未知工具。');
    },
  };
}

function executeMemoryWrite(
  options: AgentMemoryToolRuntimeOptions,
  ownerSessionKey: string,
  argumentsText: string,
): { content: string; error?: string } {
  const args = parseArguments(argumentsText);
  if (!args || typeof args.category !== 'string' || typeof args.text !== 'string') {
    return memoryError('invalid_arguments', '记忆参数格式不正确。');
  }

  const text = args.text.trim();
  if (text.length === 0) {
    return memoryError('empty_text', '记忆内容不能为空。');
  }

  if (args.category === 'fact') {
    const tag = isFactTag(args.tag) ? args.tag : 'misc';
    let result;
    try {
      result = options.facts.upsert(ownerSessionKey, text, tag);
    } catch {
      return memoryError('memory_write_failed', '记忆写入失败。');
    }
    if (!result) {
      return memoryError('memory_write_failed', '记忆写入失败。');
    }
    return {
      content: `${result.created ? '已记住' : '复习一次'}：${result.record.text}`,
    };
  }

  if (args.category === 'selfNote') {
    let note;
    try {
      note = options.selfNotes.upsert(ownerSessionKey, text);
    } catch {
      return memoryError('memory_write_failed', '自我认知写入失败。');
    }
    if (!note) {
      return memoryError('memory_write_failed', '自我认知写入失败。');
    }
    return { content: `已写下自认知：${note.text}` };
  }

  return memoryError('invalid_category', 'category 必须是 fact 或 selfNote。');
}

function executeLibraryWrite(
  library: Pick<LibraryStore, 'write'>,
  argumentsText: string,
): { content: string; error?: string } {
  const args = parseArguments(argumentsText);
  if (
    !args ||
    typeof args.title !== 'string' ||
    typeof args.text !== 'string' ||
    (args.tags !== undefined &&
      (!Array.isArray(args.tags) || !args.tags.every((tag) => typeof tag === 'string')))
  ) {
    return libraryError('invalid_arguments', '资料库参数格式不正确。');
  }
  if (args.title.trim().length === 0) {
    return libraryError('empty_title', '资料标题不能为空。');
  }
  if (args.text.trim().length === 0) {
    return libraryError('empty_text', '资料内容不能为空。');
  }

  const tags = args.tags as string[] | undefined;
  try {
    const saved = library.write({
      title: args.title,
      text: args.text,
      ...(tags === undefined ? {} : { tags }),
    });
    return {
      content: `${LIBRARY_CONTENT_FRAME}\n已保存资料：${saved.id}（《${saved.title}》）`,
    };
  } catch (error) {
    if (error instanceof LibraryStoreError) {
      if (error.code === 'empty_title') {
        return libraryError('empty_title', '资料标题不能为空。');
      }
      if (error.code === 'empty_text') {
        return libraryError('empty_text', '资料内容不能为空。');
      }
    }
    return libraryError('write_failed', '资料写入失败。');
  }
}

function executeLibrarySearch(
  library: Pick<LibraryStore, 'search'>,
  argumentsText: string,
): { content: string; error?: string } {
  const args = parseArguments(argumentsText);
  if (!args || typeof args.query !== 'string') {
    return libraryError('invalid_arguments', '资料检索参数不正确。');
  }
  if (
    args.limit !== undefined &&
    (typeof args.limit !== 'number' ||
      !Number.isInteger(args.limit) ||
      args.limit < 1 ||
      args.limit > 5)
  ) {
    return libraryError('invalid_arguments', '资料检索条数必须是 1 到 5 的整数。');
  }

  let hits;
  try {
    hits = library.search(args.query.trim(), args.limit);
  } catch {
    return libraryError('search_failed', '资料检索失败。');
  }

  const lines = [LIBRARY_CONTENT_FRAME];
  if (hits.length === 0) {
    lines.push('没有找到匹配的资料。');
  } else {
    hits.forEach((hit, index) => {
      const snippet = hit.snippet.replace(/\s+/g, ' ').trim();
      lines.push(
        `${index + 1}. 《${hit.title}》（${hit.id}，${formatLibraryDate(hit.createdAt)}）`,
        `   ${snippet}`,
      );
    });
  }
  return { content: lines.join('\n') };
}

function executeLibraryRead(
  library: Pick<LibraryStore, 'read'>,
  argumentsText: string,
): { content: string; error?: string } {
  const args = parseArguments(argumentsText);
  if (!args || typeof args.id !== 'string') {
    return libraryError('invalid_arguments', '资料读取参数不正确。');
  }
  const id = args.id.trim();
  if (id.length === 0) {
    return libraryError('invalid_id', '资料 id 不合法。');
  }

  try {
    const result = library.read(id);
    const suffix = result.truncated ? '\n…[truncated]' : '';
    return {
      content:
        `${LIBRARY_CONTENT_FRAME}\n` +
        `${result.id} 《${result.title}》（${formatLibraryDate(result.createdAt)}）\n` +
        `${result.text}${suffix}`,
    };
  } catch (error) {
    if (error instanceof LibraryStoreError) {
      if (error.code === 'invalid_id') {
        return libraryError('invalid_id', '资料 id 不合法。');
      }
      if (error.code === 'not_found') {
        return libraryError('not_found', '没有找到这条资料。');
      }
    }
    return libraryError('read_failed', '资料读取失败。');
  }
}

function parseArguments(raw: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

function isFactTag(value: unknown): value is FactTag {
  return typeof value === 'string' && Object.hasOwn(TAG_WEIGHTS, value);
}

function memoryError(code: string, message: string): {
  content: string;
  error: string;
} {
  return {
    content: `[memory_tool_error:${code}] ${message}`,
    error: code,
  };
}

function libraryError(code: string, message: string): {
  content: string;
  error: string;
} {
  return {
    content: `[library_tool_error:${code}] ${message}`,
    error: code,
  };
}

function formatLibraryDate(createdAt: string): string {
  const timestamp = Date.parse(createdAt);
  if (!Number.isFinite(timestamp)) return '0000-00-00';
  return new Date(timestamp).toISOString().slice(0, 10);
}
