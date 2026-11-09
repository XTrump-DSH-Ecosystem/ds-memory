/**
 * QQ 线脑侧内部类型（P2 T1b）。
 *
 * 冻结依据：docs/P2-INTERFACES.md §1 Receipt、§2 WakePacket。
 * 本文件只定义脑侧内部数据结构，不定义 /hook 或 /send 的线上 JSON 形状；
 * 线上契约以 docs/CONTRACT.md（v1.1 签署后）与 tests/contract/*.json 为准。
 */

// ---------- 收件箱内部输入（T3） ----------

/** 群聊发送者权限；私聊固定 owner。缺省按 member 处理（fail-closed）。 */
export type QqSenderRole = 'owner' | 'member';

/**
 * 脑侧内部归一化输入；不是 /hook 的线上 JSON 形状。
 * text 始终是完整原文，speaker/quote 只作为独立元数据参与模型侧拼装。
 */
export interface InboxItem {
  eventId: string;
  sessionKey: string;
  kind: 'private' | 'group';
  speaker: string | null;
  senderRole?: QqSenderRole;
  /** 事件来源：实时 hook 或启动恢复。缺失一律按 fail-closed 处理。 */
  origin?: 'live' | 'recovered';
  /** 发送者 QQ；仅用于 owner 联网判定，缺失一律按 fail-closed 处理。 */
  senderQqId?: string;
  text: string;
  quote: { fromName: string; text: string } | null;
  isAtBot: boolean;
  receivedAt: number;
}

// ---------- §1 Receipt ----------

export type ReceiptStatus =
  | 'received' // 完整事件已持久化（含 L0 user 原文），尚未进入模型；ACK 前必须达到
  | 'processing' // 首次调用 provider 前已持久化；已进入模型
  | 'done' // 终态：处理完成并记录发送结果；部分送达也是终态，不自动重试
  | 'failed' // 终态：模型 / L0 / 发送最终失败，本轮放弃，不自动重试
  | 'aborted'; // 终态：仅重启恢复时发现 processing，终止补投

export type ReceiptOutcome =
  | 'replied' // done：至少一条 assistant 实际送达并落盘
  | 'stored_only' // done：只保存不唤醒（群 mention 之外的群消息）
  | 'failed' // failed
  | 'aborted'; // aborted

export interface Receipt {
  eventId: string; // 不透明字符串，仅去重；= L0 user 记录 id
  sessionKey: string | null; // 权限判定后确定；判定前为 null
  status: ReceiptStatus;
  outcome: ReceiptOutcome | null;
  receivedAt: number; // 毫秒
  processingAt: number | null;
  doneAt: number | null;
  failureReason: string | null;
  sentIndexes: number[] | null; // done(replied)：实际送达的原始 index（0 起始）
  failedIndexes: number[] | null; // done(replied)：未送达的原始 index
}

// ---------- §2 WakePacket ----------

export interface WakeItem {
  eventId: string;
  speaker: string | null; // 群昵称；私聊 null（模型侧再由组装层映射「你/我」语义）
  senderRole?: QqSenderRole; // 群聊 owner/member；缺省按 member 处理
  origin?: 'live' | 'recovered'; // 事件来源；缺失一律 fail-closed（不得执行命令）
  quote: { fromName: string; text: string } | null; // 独立元数据，不拼进 text
  text: string; // 完整原文（L0 保真）
  at: number; // 事件时间
}

export interface WakePacket {
  sessionKey: string;
  items: WakeItem[]; // 本批进模型的完整原文条目（≤ batchMaxMessages=12）
  omittedEventIds: string[]; // 因条数/字符上限未进本批的 eventId；进下一批次，原文不丢
  modelText: string; // 有界模型输入（≤ batchMaxChars=4000，标签与省略提示计入）
  totalChars: number; // modelText 字符总数（≤4000）
  truncatedCount: number; // 因单条 300 字被截断的条数
}

// ---------- §1 ReceiptStore（T1.5a 追加） ----------

export interface ReserveInput {
  eventId: string;
  sessionKey: string;
  role: 'user';
  text: string; // 完整原文，不拼接
  speaker: string | null; // 群昵称；私聊 null
  quote: { fromName: string; text: string } | null; // 独立元数据
  isAtBot: boolean; // 群 @/引用唤醒依据；写入 L0 独立元数据
  senderQqId: string; // 发送者 QQ（内部元数据，由线上 sender.qqId 派生）
  modelEligible: boolean; // 是否可进模型/检索；非 owner 群消息为 false
  at: number;
}

export interface RecoveredReceipt {
  receipt: Receipt;
  record: import('../memory/store.ts').RawRecord;
}

export type ReserveResult =
  | { kind: 'new'; receipt: Receipt } // 本次成功持久化 received，可 ACK 200
  | { kind: 'duplicate'; receipt: Receipt } // Receipt 已存在：不重写 L0、不入队、不唤醒，仍 ACK 200
  | { kind: 'ignored'; reason: 'foreign_l0' | 'before_receipts_since' }; // 不产生 Receipt、不入队、不唤醒

export interface ReceiptStore {
  /**
   * 去重临界区：先检查 Receipt：
   * - Receipt 已存在 → duplicate；
   * - Receipt 已从内存 prune 但持久化 tombstone 为终态 → 仍按 duplicate，不能当 L0-only 恢复；
   * - Receipt 缺失且 appendResult=duplicate（L0 已有同 id）时，只有可恢复的 QQ user L0
   *   → 同步补建 received，返回 new（崩溃恢复，不重写 L0）；
   * - 同上的 L0 为 CLI/assistant → 返回 ignored(foreign_l0)，不补建、不入队；
   * - 同上的 L0 早于 receiptsSince → 返回 ignored(before_receipts_since)，不补建、不入队；
   * - L0 也没有 → 写 L0 user 原文(id=eventId) + 写 received，返回 new。
   * - store 报 appendResult=duplicate 但返回的既有 record 缺失/无效，或 t 无法解析 → 抛错，调用方不得 ACK（→ 503）。
   * 同一 eventId 并发/重复调用时只能产生一个 'new'；已有 Receipt 的重复调用为 duplicate，
   * 其余未产生新 Receipt 的路径为 ignored。
   * 实现约束：单进程单线程内以同步「检查 + 写」完成，临界区不得出现 await。
   * 持久化失败必须让调用方明确得知（抛错或返回失败结果），调用方不得 ACK（→ 503）。
   */
  reserve(input: ReserveInput): ReserveResult;

  /** received → processing；首次调用 provider 前调用。 */
  markProcessing(eventId: string): boolean;

  /** received → done(outcome=stored_only)；群只保存不唤醒时调用。 */
  markStoredOnly(eventId: string): boolean;

  /** processing → done(outcome=replied)；按实际送达结果写 assistant L0 后调用。 */
  markDone(eventId: string, sentIndexes: number[], failedIndexes: number[]): boolean;

  /** → failed；模型/L0/发送最终失败时调用。 */
  markFailed(eventId: string, reason: string): boolean;

  /**
   * 启动恢复（必须在监听 /hook 前完成）：
   * - 首次启用时先持久化 receiptsSince（毫秒）；缺失且有历史 Receipt 时启动失败；
   * - 把遗留 processing 置为 aborted；
   * - 仅扫描 src=qq、role=user、t>=receiptsSince 的 L0 记录，为缺失 Receipt 的 eventId 补建 received（不重写 L0）；
   * - 先按持久化 terminal tombstone 排除 done/failed/aborted，禁止恢复终态；
   * - 返回所有可恢复的 received Receipt（连同 L0 记录，供服务层按 isAtBot/groupWake 分流）与 aborted eventId。
   * - 服务层分流时 isAtBot 只认严格 === true；缺失、非布尔、"yes"、1、null 等一律按 false，私聊不受该字段影响。
   * - 若收到 received 但找不到对应 L0 记录，视为数据不一致并使启动失败，不得入队。
   * 写入失败必须让启动失败，不得带着不确定状态开始接收。
   */
  bootstrapFromL0(): { recovered: RecoveredReceipt[]; aborted: string[] };

  /**
   * 只清理内存缓存，不得删除持久化终态 tombstone；
   * L0 去重事实与终端事件抑制必须跨重启保留。
   */
  prune(now: number): void;
}

// ---------- §3 ReplyPlan ----------

export interface ReplyPlan {
  // 有序；每轮优先 1 条完整回复，仅超过 3000 字安全上限时按边界分块。
  // 0 条 = 不发送（send.maxPerTurn=0 的静音兼容）；正数 maxPerTurn 不再截断。
  messages: string[];
}

// ---------- §4 SendResult ----------

export type SendOutcome = 'all_sent' | 'partial' | 'none_sent' | 'ambiguous_failure';

export interface SendResult {
  outcome: SendOutcome;
  sentIndexes: number[]; // 原始 index（0 起始），跨重试累计实际送达
  failedIndexes: number[]; // 原始 index（0 起始），未送达（含 not_attempted）
  retryable: boolean; // 仅 429 且未达重试上限、retryAfter<=30000 时为 true
  retryAfterMs: number | null; // 429 的 X-Retry-After-Ms；>30000 视为放弃本轮
  reason: string | null;
}

// ---------- 传输端口（T1.5b，签署版 CONTRACT §3 / §5） ----------

export interface QqTarget {
  kind: 'private' | 'group';
  id: string;
}

export interface QqSendOptions {
  replyToMessageId?: string | null;
  reason?: 'reply' | 'proactive' | 'admin';
  signal?: AbortSignal;
}

export interface QqSender {
  send(target: QqTarget, messages: string[], opts?: QqSendOptions): Promise<SendResult>;
}
