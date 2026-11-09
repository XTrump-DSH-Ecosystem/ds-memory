import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

export type SessionKind = 'private' | 'group';

export interface SessionSource {
  kind: SessionKind;
  id: string;
  groupName?: string | null;
}

export type SessionAction = 'allow' | 'deny' | 'ignore';

export type SessionReason =
  | 'owner'
  | 'allow_group'
  | 'deny_private'
  | 'deny_group'
  | 'stranger_private'
  | 'group_not_allowed';

export interface SessionDecision {
  action: SessionAction;
  sessionKey: string | null;
  reason: SessionReason;
  modelEligible: boolean;
}

export interface QqSessionRecord {
  sessionKey: string;
  kind: SessionKind;
  id: string;
  groupName: string | null;
  firstSeenAt: number;
  lastSeenAt: number;
  messageCount: number;
}

export interface SessionMapOptions {
  stateDir: string;
  ownerQQ: number;
  allowGroups: number[];
  denyPrivate: number[];
  denyGroups: number[];
  /** 是否允许白名单群普通成员在 @/引用机器人时进入模型。 */
  allowGroupMemberReply?: boolean;
  /** mention：仅 @/引用；all：管理员或成员消息都可唤醒。 */
  groupWake?: 'mention' | 'all';
  now?: () => number;
  onWarn?: (message: string) => void;
}

export interface SessionClassifyOptions {
  /** 仅群聊有效；由线上事件解析结果传入。 */
  isAtBot?: boolean;
}

interface SessionsFile {
  v: 1;
  sessions: QqSessionRecord[];
}

export function privateSessionKey(id: string): string {
  return `private:${id}`;
}

export function groupSessionKey(id: string): string {
  return `group:${id}`;
}

function numericId(id: string): number | null {
  if (!/^\d+$/.test(id)) return null;
  const value = Number(id);
  return Number.isSafeInteger(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseSession(value: unknown): QqSessionRecord | null {
  if (!isRecord(value)) return null;
  if (typeof value.sessionKey !== 'string' || value.sessionKey.length === 0) return null;
  if (value.kind !== 'private' && value.kind !== 'group') return null;
  if (typeof value.id !== 'string') return null;
  if (value.groupName !== null && typeof value.groupName !== 'string') return null;
  if (typeof value.firstSeenAt !== 'number' || !Number.isFinite(value.firstSeenAt)) return null;
  if (typeof value.lastSeenAt !== 'number' || !Number.isFinite(value.lastSeenAt)) return null;
  if (
    typeof value.messageCount !== 'number' ||
    !Number.isInteger(value.messageCount) ||
    value.messageCount < 0
  ) {
    return null;
  }

  return {
    sessionKey: value.sessionKey,
    kind: value.kind,
    id: value.id,
    groupName: value.groupName,
    firstSeenAt: value.firstSeenAt,
    lastSeenAt: value.lastSeenAt,
    messageCount: value.messageCount,
  };
}

function cloneSession(record: QqSessionRecord): QqSessionRecord {
  return { ...record };
}

/**
 * QQ 会话映射与权限判定（§6）。
 *
 * 权限顺序：denyPrivate/denyGroups（deny/403）> owner（私聊）> allowGroups >
 * 其余静默忽略。只有 allow 会创建会话；deny/ignore 不落任何会话状态。
 */
export class SessionMap {
  private readonly filePath: string;
  private readonly ownerQQ: number;
  private readonly allowGroups: Set<number>;
  private readonly denyPrivate: Set<number>;
  private readonly denyGroups: Set<number>;
  private readonly allowGroupMemberReply: boolean;
  private readonly groupWake: 'mention' | 'all';
  private readonly now: () => number;
  private readonly onWarn: (message: string) => void;

  private loaded = false;
  private readonly sessions = new Map<string, QqSessionRecord>();

  constructor(options: SessionMapOptions) {
    this.filePath = join(options.stateDir, 'qq-sessions.json');
    this.ownerQQ = options.ownerQQ;
    this.allowGroups = new Set(options.allowGroups);
    this.denyPrivate = new Set(options.denyPrivate);
    this.denyGroups = new Set(options.denyGroups);
    this.allowGroupMemberReply = options.allowGroupMemberReply === true;
    this.groupWake = options.groupWake ?? 'mention';
    this.now = options.now ?? Date.now;
    this.onWarn = options.onWarn ?? ((message) => console.warn(message));
  }

  /** 纯判定，不读盘、不写盘。senderQQ 用于群消息的模型准入；私聊仍按会话 id 判定 owner。 */
  classify(
    source: SessionSource,
    senderQQ?: string | null,
    options: SessionClassifyOptions = {},
  ): SessionDecision {
    const id = numericId(source.id);

    if (source.kind === 'private') {
      if (id !== null && this.denyPrivate.has(id)) {
        return { action: 'deny', sessionKey: null, reason: 'deny_private', modelEligible: false };
      }
      if (id !== null && this.ownerQQ > 0 && id === this.ownerQQ) {
        return {
          action: 'allow',
          sessionKey: privateSessionKey(source.id),
          reason: 'owner',
          modelEligible: true,
        };
      }
      return { action: 'ignore', sessionKey: null, reason: 'stranger_private', modelEligible: false };
    }

    if (id !== null && this.denyGroups.has(id)) {
      return { action: 'deny', sessionKey: null, reason: 'deny_group', modelEligible: false };
    }
    if (id !== null && this.allowGroups.has(id)) {
      const isOwner =
        this.ownerQQ > 0 &&
        senderQQ !== null &&
        senderQQ !== undefined &&
        senderQQ === String(this.ownerQQ);
      const memberEligible =
        this.allowGroupMemberReply &&
        (options.isAtBot === true || this.groupWake === 'all');
      return {
        action: 'allow',
        sessionKey: groupSessionKey(source.id),
        reason: 'allow_group',
        modelEligible: isOwner || memberEligible,
      };
    }
    return { action: 'ignore', sessionKey: null, reason: 'group_not_allowed', modelEligible: false };
  }

  /**
   * 仅 allow 时登记会话；返回 sessionKey。
   * deny/ignore 返回 null，且不创建会话、不写文件。
   */
  record(source: SessionSource, at: number = this.now(), senderQQ?: string | null): string | null {
    const decision = this.classify(source, senderQQ);
    if (decision.action !== 'allow' || decision.sessionKey === null) return null;

    this.ensureLoaded();
    const existing = this.sessions.get(decision.sessionKey);
    const next: QqSessionRecord = existing
      ? {
          ...existing,
          groupName: source.groupName ?? existing.groupName,
          lastSeenAt: at,
          messageCount: existing.messageCount + 1,
        }
      : {
          sessionKey: decision.sessionKey,
          kind: source.kind,
          id: source.id,
          groupName: source.groupName ?? null,
          firstSeenAt: at,
          lastSeenAt: at,
          messageCount: 1,
        };

    this.sessions.set(decision.sessionKey, next);
    this.persist();
    return decision.sessionKey;
  }

  get(sessionKey: string): QqSessionRecord | undefined {
    this.ensureLoaded();
    const record = this.sessions.get(sessionKey);
    return record ? cloneSession(record) : undefined;
  }

  list(): QqSessionRecord[] {
    this.ensureLoaded();
    return [...this.sessions.values()].map(cloneSession);
  }

  get count(): number {
    this.ensureLoaded();
    return this.sessions.size;
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!existsSync(this.filePath)) return;

    try {
      const parsed: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'));
      if (!isRecord(parsed) || parsed.v !== 1 || !Array.isArray(parsed.sessions)) {
        throw new Error('invalid sessions file');
      }
      for (const item of parsed.sessions) {
        const record = parseSession(item);
        if (record) this.sessions.set(record.sessionKey, record);
      }
    } catch {
      this.onWarn('qq-sessions 读取失败，按空会话继续');
    }
  }

  private persist(): void {
    const payload: SessionsFile = {
      v: 1,
      sessions: [...this.sessions.values()],
    };
    const tempPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;

    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      renameSync(tempPath, this.filePath);
    } catch {
      try {
        rmSync(tempPath, { force: true });
      } catch {
        // 忽略临时文件清理失败
      }
      this.onWarn('qq-sessions 写入失败');
    }
  }
}
