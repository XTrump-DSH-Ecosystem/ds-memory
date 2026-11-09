/**
 * 签署版 `/hook/message` 线上形状（CONTRACT v1.1 §2）。
 * 只描述网关 → 脑的 wire shape，不包含 OneBot 协议或任何发送实现。
 */

export interface HookQuote {
  text: string;
  fromName: string;
}

export interface HookSource {
  kind: 'private' | 'group';
  id: string;
  groupName?: string | null;
}

export interface HookSender {
  qqId: string;
  nickname: string;
}

export interface HookEvent {
  v: 1;
  eventId: string;
  at: number;
  source: HookSource;
  sender: HookSender;
  messageId?: string;
  text: string;
  isAtBot: boolean;
  quote: HookQuote | null;
  media: unknown[];
  poke: { fromName: string } | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * 严格按签署版形状校验并归一化可选字段。
 * 不做权限、不读 L0、不触网络。
 */
export function parseHookEvent(value: unknown): HookEvent | null {
  if (!isRecord(value)) return null;
  if (value.v !== 1) return null;
  if (!isNonEmptyString(value.eventId)) return null;
  if (typeof value.at !== 'number' || !Number.isFinite(value.at)) return null;
  if (typeof value.text !== 'string') return null;
  if (typeof value.isAtBot !== 'boolean') return null;

  const source = value.source;
  if (!isRecord(source)) return null;
  if (source.kind !== 'private' && source.kind !== 'group') return null;
  if (!isNonEmptyString(source.id)) return null;
  if (
    source.groupName !== undefined &&
    source.groupName !== null &&
    typeof source.groupName !== 'string'
  ) {
    return null;
  }

  const sender = value.sender;
  if (!isRecord(sender)) return null;
  if (!isNonEmptyString(sender.qqId)) return null;
  if (typeof sender.nickname !== 'string') return null;

  if (value.messageId !== undefined && typeof value.messageId !== 'string') return null;

  let quote: HookQuote | null = null;
  if (value.quote !== undefined && value.quote !== null) {
    if (!isRecord(value.quote)) return null;
    if (typeof value.quote.text !== 'string' || typeof value.quote.fromName !== 'string') {
      return null;
    }
    quote = { text: value.quote.text, fromName: value.quote.fromName };
  }

  if (value.media !== undefined && !Array.isArray(value.media)) return null;

  let poke: { fromName: string } | null = null;
  if (value.poke !== undefined && value.poke !== null) {
    if (!isRecord(value.poke) || typeof value.poke.fromName !== 'string') return null;
    poke = { fromName: value.poke.fromName };
  }

  return {
    v: 1,
    eventId: value.eventId,
    at: value.at,
    source: {
      kind: source.kind,
      id: source.id,
      groupName: source.groupName ?? null,
    },
    sender: {
      qqId: sender.qqId,
      nickname: sender.nickname,
    },
    ...(value.messageId !== undefined ? { messageId: value.messageId } : {}),
    text: value.text,
    isAtBot: value.isAtBot,
    quote,
    media: Array.isArray(value.media) ? value.media : [],
    poke,
  };
}
