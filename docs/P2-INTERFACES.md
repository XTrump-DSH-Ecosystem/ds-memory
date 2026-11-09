# P2 脑侧四接口冻结稿（r3 · M3 duplicate 边界修订）

> 本文件冻结 T2～T5 之间的四个脑侧内部接口：`Receipt`、`WakePacket`、`ReplyPlan`、`SendResult`。
> 冻结边界：全部为**脑侧内部类型**，不定义 `/hook` 或 `/send` 的线上 JSON 形状。
> 线上形状的权威仍是 `docs/CONTRACT.md`（v1.1 草案 + `tests/contract/*.json` + `manifest.sha256`）。
> 纪律：本文件随 P2 T1 冻结入库；r3 为待签修订，签署/验收后更新入库；与 `docs/CONTRACT.md` 冲突时以已签署的 CONTRACT 为准。
> 依据：`docs/DECISION-LOG.md` 裁决 A/B/C、G1/G3/G4/G5/G6/G7；`docs/P2-TASK-BREAKDOWN.md` §4。
> r2 修订：补 M3 恢复语义、L0 `isAtBot` 元数据与 `bootstrapFromL0`；r3 增量：补 `duplicate` 来源判定与 `ReserveResult.ignored`。两版均不改变线上 JSON 形状。
> r5 增量（v1.3）：群聊普通成员在 `@`/引用机器人时可进入模型；`InboxItem`/`WakeItem` 增加内部字段 `senderRole`，用于 member 限流和 `[管理员]`/`[群友]` 模型标签。`owner` 命令仍只接受单条 owner 批次；不改变线上 JSON 形状。

## 0. 冻结后的统一数据流

```text
POST /hook/message
 → token 鉴权(401) → 形状校验(400) → 权限(403 或静默忽略)
 → 启动：bootstrapFromL0（processing→aborted；L0 缺失 Receipt 补建 received）
 → reserve(eventId)【去重临界区：检查 Receipt + 写 L0 user 原文 + 写 received】
 → L0 + Receipt 持久化成功才 200 {ok:true}；持久化失败 → 503（网关在 TTL 内退避重试，TTL 不重置）
 → 收件箱 / 合批
 → 群「仅保存」消息：received → done(stored_only)，不唤醒
 → 普通唤醒：WakePacket（有界）
 → markProcessing(eventId)【首次调用 provider 前持久化 processing】
 → Agent 推理（Agent 不再写 user L0；接收层是唯一 user L0 写入方）
 → ReplyPlan → QqClient.send → SendResult
 → 按 sentIndexes 把实际送达内容写 assistant L0 → markDone
```

关键结论（已评审）：

- **eventId = L0 user 记录的 `id`**。去重复用 `EventStore` 的 `seenIds` 重建机制，满足 G1「重启后从已持久化 L0 重建去重窗口」；`dedupeTtlMs` 只控制易失 Receipt 终态条目的清理，不改 L0 永久去重事实。
- **接收层是 QQ 线唯一 user L0 写入方**；`Agent.runTurn` 在 QQ 线不再写 user L0，消除双写。
- **L0 的 `text` 是完整原文**；说话人、引用、唤醒标签放独立元数据，绝不拼进 `text`。
- **200 的可观察保证**：L0 + Receipt 已持久化；重启后同一 `eventId` 要么已是终态/processing，要么可作为 `received` 恢复入队。不是“已回复”。
- **恢复双保险**：启动时从 L0 补建缺失 Receipt；运行时重复路径遇到 L0-only 也补建 Receipt，且只算一次恢复唤醒。

## 1. Receipt（冻结）

```ts
export type ReceiptStatus =
  | 'received'    // 完整事件已持久化（含 L0 user 原文），尚未进入模型；ACK 前必须达到
  | 'processing'  // 首次调用 provider 前已持久化；已进入模型
  | 'done'        // 终态：处理完成并记录发送结果；部分送达也是终态，不自动重试
  | 'failed'      // 终态：模型 / L0 / 发送最终失败，本轮放弃，不自动重试
  | 'aborted';    // 终态：仅重启恢复时发现 processing，终止补投

export type ReceiptOutcome =
  | 'replied'      // done：至少一条 assistant 实际送达并落盘
  | 'stored_only'  // done：只保存不唤醒（群 mention 之外的群消息）
  | 'failed'       // failed
  | 'aborted';     // aborted

export interface Receipt {
  eventId: string;               // 不透明字符串，仅去重；= L0 user 记录 id
  sessionKey: string | null;     // 权限判定后确定；判定前为 null
  status: ReceiptStatus;
  outcome: ReceiptOutcome | null;
  receivedAt: number;            // 毫秒
  processingAt: number | null;
  doneAt: number | null;
  failureReason: string | null;
  sentIndexes: number[] | null;    // done(replied)：实际送达的原始 index（0 起始）
  failedIndexes: number[] | null;  // done(replied)：未送达的原始 index
}
```

允许迁移（其余一律非法）：

```text
received ──→ processing ──→ done
                      └──→ failed
received ──→ done（outcome=stored_only）
received ──→ failed
processing ──→ aborted（仅重启恢复）
```

```ts
export interface ReserveInput {
  eventId: string;
  sessionKey: string;
  role: 'user';
  text: string;                                  // 完整原文，不拼接
  speaker: string | null;                        // 群昵称；私聊 null
  quote: { fromName: string; text: string } | null; // 独立元数据
  isAtBot: boolean;                              // 群 @/引用唤醒依据；写入 L0 独立元数据
  senderQqId: string;                            // 发送者 QQ（内部元数据，由线上 sender.qqId 派生）
  modelEligible: boolean;                        // 是否可进模型/检索；mention 下普通成员仅 @/引用为 true
  at: number;
}

export interface RecoveredReceipt {
  receipt: Receipt;
  record: import('../memory/store.ts').RawRecord;
}

export type ReserveResult =
  | { kind: 'new'; receipt: Receipt }     // 本次成功持久化 received，可 ACK 200
  | { kind: 'duplicate'; receipt: Receipt } // Receipt 已存在：不重写 L0、不入队、不唤醒，仍 ACK 200
  | { kind: 'ignored'; reason: 'foreign_l0' | 'before_receipts_since' };
  // ignored：既有 L0 不是可恢复的 QQ user 记录；200 零副作用，不建 Receipt、不入队、不唤醒

export interface ReceiptStore {
  /**
   * 去重临界区：先检查 Receipt：
   * - Receipt 已存在 → duplicate；
   * - Receipt 已从内存 prune 但持久化 tombstone 为终态 → 仍按 duplicate，不能当 L0-only 恢复；
   * - Receipt 缺失但 L0 已有同 id（appendResult=duplicate）→ 用返回的既有 record 核对：
   *   - src=qq、role=user、t>=receiptsSince → 补建 received，返回 new（不重写 L0）；
   *   - CLI/assistant 或早于 receiptsSince → 返回 ignored，200 零副作用；
   *   - record 缺失/无效，或 `t` 无法解析 → 抛出或返回失败（调用方 503），不能当普通重复；
   * - L0 也没有 → 写 L0 user 原文(id=eventId) + 写 received，返回 new。
   * 同一 eventId 并发/重复调用时只能产生一个 'new'；既有 Receipt 为 'duplicate'，不可恢复来源为 'ignored'。
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
```

精确迁移点（评审已定）：

- `received`：`reserve` 成功即达成；**ACK 前必须达成**。
- `processing`：**首次调用 provider 前**完成持久化；不是进入收件箱或开始合批时。
- `done/failed/aborted`：终态，不自动重试。
- 重复 `eventId`（Receipt 已存在）：不重写 L0、不入队、不唤醒，返回相同 `200 {ok:true}`。
- L0-only（Receipt 缺失但为可恢复 QQ user 记录）：属于未完成接收；补建 Receipt 后可恢复一次入队，返回 `new`，不是普通重复。
- 外来 L0（CLI/assistant）或水位前 QQ L0：`ignored`，200 零副作用；查不到/无效记录或 `t` 无法解析抛错/失败，调用方 503。
- 重启补投：只补投 `received`（尚未进入模型）；`processing` 一律 `aborted`，防止重复回复。

## 2. WakePacket（冻结）

```ts
export interface WakeItem {
  eventId: string;
  speaker: string | null;   // 群昵称；私聊 null（模型侧再由组装层映射「你/我」语义）
  senderRole?: 'owner' | 'member'; // 群聊权限标签；缺省按 member fail-closed
  origin?: 'live' | 'recovered'; // 事件来源；缺省 fail-closed（不得执行命令）
  quote: { fromName: string; text: string } | null; // 独立元数据，不拼进 text
  text: string;             // 完整原文（L0 保真）
  at: number;               // 事件时间
}

export interface WakePacket {
  sessionKey: string;
  items: WakeItem[];           // 本批进模型的完整原文条目（≤ batchMaxMessages=12）
  omittedEventIds: string[];   // 因条数/字符上限未进本批的 eventId；进下一批次，原文不丢
  modelText: string;           // 有界模型输入（≤ batchMaxChars=4000，标签与省略提示计入）
  totalChars: number;          // modelText 字符总数（≤4000）
  truncatedCount: number;      // 因单条 300 字被截断的条数
}
```

组装规则（冻结）：

- `items[].text` 永远是完整原文，不拼接昵称、引用前缀或唤醒标签。
- `items[].origin` 从 `InboxItem` 透传；缺失按 fail-closed 处理。owner 记忆命令只在单条、`senderRole=owner` 且 `origin='live'` 时执行；`recovered` 或缺失不得执行。
- `modelText` 由 `items` 拼装：群消息带 `[管理员]` 或 `[群友]` 说话人标签；`quote` 拼成 `[引用 张三：原文]` 前缀；**单条消息正文 ≤300 字**，超出截断并计 `truncatedCount`；因条数/总字符超限被省略的条目进 `omittedEventIds`，同时 `modelText` 尾部加省略提示。
- 说话人标签、引用前缀、单条截断标记、省略提示**全部计入** `totalChars` 的 4000 上限（不占单条正文 300 字）。
- 三重上限：条数 12 / 单条正文 300 字 / 总计 4000 字（含标签与省略提示）；超限只进入下一批，**不得丢弃原文**。

## 3. ReplyPlan（冻结）

```ts
export interface ReplyPlan {
  // 有序；每轮优先 1 条完整回复，仅超过 3000 字安全上限时按边界分块
  messages: string[];
}
```

规则（冻结）：

- 由 T4 生成；普通回复默认完整一条，不再按句拆条、不再静默截断。
- 单条安全上限 `QQ_REPLY_MAX_CHARS=3000` 字（按 Unicode 码点计）；超过时优先在换行、句末标点、空白后分块，最后才硬切，且不得切开 emoji 代理对。所有分块按序拼接必须等于 `text.trim()` 后的规范化原文（仅去掉首尾空白）。
- `send.maxPerTurn=0` 保留静音语义（空计划）；其他正数不再作为截断上限，仅用于配置兼容。
- 空数组 = 不调用 `/send`。
- 分块时只记录分块数量，不记录正文。
- T5（`QqClient.send`）只发送，不负责拆句或分块。
- 引用回复目标（`replyToMessageId`）是独立发送选项，由编排层从触发事件派生传入 T5，不属于 `ReplyPlan`。

## 4. SendResult（冻结）

```ts
export type SendOutcome = 'all_sent' | 'partial' | 'none_sent' | 'ambiguous_failure';

export interface SendResult {
  outcome: SendOutcome;
  sentIndexes: number[];        // 原始 index（0 起始），跨重试累计实际送达
  failedIndexes: number[];      // 原始 index（0 起始），未送达（含 not_attempted）
  retryable: boolean;           // 仅 429 且未达重试上限、retryAfter<=30000 时为 true
  retryAfterMs: number | null;  // 429 的 X-Retry-After-Ms；>30000 视为放弃本轮
  reason: string | null;
}
```

不变量（冻结）：

- `failed.index` 按 0 起始解释。
- `sentIndexes` 以「本次请求 index 集合 − failed index 集合」推导，**不依赖 sent 数组顺序**。
- `sentIndexes` 与 `failedIndexes` 互斥，并集等于本次请求全部 index，数量之和等于请求条数。
- 重试后的 `sentIndexes` 必须累计所有已实际送达的原始 index；最终 `outcome` 按累计结果判定（全部送达才是 `all_sent`）。
- `failed` 缺失、index 越界、重复、遗漏或数量不符 → `outcome='ambiguous_failure'`，不重试。
- 重试：仅 429 且只重试 `failed` 中的原始 index，最多 2 次；子包局部 index 必须映射回原始 index；`X-Retry-After-Ms` 优先，缺失用 2s/10s，值 >30s 放弃；超时/网络/5xx/非法响应体一律 `ambiguous_failure`，不做歧义重试。
- 400/401/413 为 `none_sent`；200 非 429 失败按 `sent` 前缀得到 `partial`/`none_sent`；5xx、超时、网络错误、非法响应为 `ambiguous_failure`。
- 不引入 `sendId`。
- 本接口只定义脑侧语义，**不定义 `/send` 线上 JSON**；线上形状以 CONTRACT v1.1（G4）+ fixtures 为准。

## 5. 冻结边界与依赖

已冻结：四个脑侧内部类型 + 状态机 + 不变量。

未冻结（不得提前实现）：`HookEvent`、`QqTarget`、`SendResult` 对应的线上响应形状、`/hook` 与 `/send` 的请求/响应 JSON；`SendResult` 的脑侧内部语义已冻结。这些线上形状等 CONTRACT v1.1 签署 + fixtures 同步后由 T2/T5 按契约派生。

r2 仅新增：`ReserveInput.isAtBot`、`RecoveredReceipt`、L0 `isAtBot` 恢复元数据、`ReceiptStore.bootstrapFromL0()`，以及 L0-only 的补建/恢复语义；不改变 `Receipt`、`WakePacket`、`ReplyPlan`、`SendResult` 的字段或线上形状。

r3 仅新增：`AppendResult.duplicate.record` 的来源判定、`ReserveResult.ignored` 与运行期 duplicate 的三分支语义；不改变四个核心接口字段或线上形状。

r4 仅更新 `ReplyPlan` 的生成语义：完整回复 + 3000 字安全分块，`maxPerTurn` 仅保留 0=静音兼容；字段与线上形状不变。

r5 仅新增 `WakeItem.origin?: 'live' | 'recovered'`（从 `InboxItem` 透传，缺失 fail-closed），用于阻止 recovered 重放 owner 记忆命令；不改变 `Receipt`、`ReplyPlan`、`SendResult` 或线上形状。

接口依赖：

- T3 依赖 `Receipt` + `WakePacket`。
- T4 依赖 `WakePacket` + `ReplyPlan` + `SendResult`。
- T5 只依赖 `SendResult` 的脑侧语义（线上形状在 v1.1 签署后补齐）。

## 6. 签署请求

请总负责确认本文件四接口冻结无误。确认后：

1. 放行 T3（含普通私离合批；`groupWake` 默认 `"mention"`）。
2. T4 群回合在接口冻结后开工（普通私离回合可并行准备）。
3. T2/T5 仍等 CONTRACT v1.1 签署 + fixtures 同步后放行。
