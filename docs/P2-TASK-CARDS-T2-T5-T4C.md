# P2 后续任务卡（T1.5a/T1.5b/T1.6 / T2 / T5 / T4c / T6 预写稿）

> 状态：**T2/T5/T4c 已交付并独立复核 PASS**；T1.5a/T1.5a-r/T1.5b/T1.6/T1.6b 已完成；v1.1 已于 2026-11-04 签署；**T6a/T6b 已交付并独立复核 PASS（390 tests）**；本文件不 commit（工作文档）。
> 前置：`docs/CONTRACT.md` v1.1 签署生效；T1.5a（纯内部 ports）已完成，T1.5b（传输端口类型）随签署补齐。
> 纪律：Worker 只改各自允许路径；不 commit/push；不新增依赖；不改
> `docs/CONTRACT.md`、`docs/DECISION-LOG.md`、`docs/P2-INTERFACES.md`、`tests/contract/**`。
> 验收重试规则：仅 `Unhandled Rejection: Channel closed`（tinypool teardown）允许一次自动重跑并留证据；
> 集成测试首跑必须绿；其他失败不得重跑。

**全卡安全约束**

- 只绑定/连接字面量 `127.0.0.1`；不得写 `localhost` 或非回环地址。
- `hookToken`、`X-Memory-Token` 不得出现在日志、断言输出、fixture、端点文件或错误正文中。
- 不启动/停止 SnowLuma，不连接真实 QQ，不写任何 OneBot 协议实现；集成测试只用本机假网关。
- 请求体上限按契约执行（`/hook/message` 与 `/send` 均为 64 KB）；端点文件只含地址元数据。
- Worker 不得自行扩大允许路径、改公开接口、改冻结语义或跳过测试；遇到停止条件立即报告。

## 0. 依赖与并行边界

| 任务 | 写入范围 | 读取（只读） | 前置 |
| --- | --- | --- | --- |
| T1.5a | `src/qq/types.ts`（只加纯内部冻结接口） | `docs/P2-INTERFACES.md` | 无（可先做） |
| T1.5b | `src/qq/types.ts`（只补 `QqTarget`/`QqSendOptions`/`QqSender`） | 签署版 CONTRACT、`docs/P2-INTERFACES.md` | T1.5a + v1.1 签署 |
| T1.6 | `src/memory/store.ts`、`tests/unit/store.test.ts`（三态写入 + `isAtBot` 元数据） | `docs/P2-INTERFACES.md`、现有 P0/P1 存储约定 | 无（可先做，必须保持 CLI 兼容） |
| T2 | `src/qq/{hooks,receipts,session-map,endpoint,wire}.ts`、`tests/unit/{receipts,session-map}.test.ts`、`tests/integration/hooks.test.ts` | `types.ts`、`config/load.ts`、`memory/store.ts`、`tests/contract/**` | T1.5a/T1.5b + T1.6 + v1.1 签署 |
| T5 | `src/qq/{client,discovery}.ts`、`tests/unit/{client,discovery}.test.ts` | `types.ts`、`config/load.ts`、签署版 CONTRACT | T1.5a/T1.5b + v1.1 签署 |
| T4c | `src/qq/{reply,turn}.ts`、`tests/unit/{reply,turn}.test.ts` | `types.ts`、`agent/loop.ts`、`agent-registry.ts`、`docs/P2-INTERFACES.md` | T1.5a/T1.5b + v1.1 签署 |
| T6 | `src/main.ts`、`src/qq/{service,lock,hooks}.ts`、`src/qq/{discovery,client,turn}.ts`、`src/config/load.ts`、`src/util/redact.ts`、`package.json`、`tests/unit/{lock,config,discovery,client,turn,redact}.test.ts`、`tests/integration/{hooks,serve}.test.ts` | 全部 | T2/T5/T4c 全部通过 |

- T2/T5/T4c 可**并行**；三者不得改 `src/qq/types.ts`（T1.5a/T1.5b 独占）。
- T1.6 与 T1.5a 写路径不重叠，可并行；T2 必须等 T1.6 通过。
- T2/T5/T4c 都不得改 `src/main.ts`；装配留给 T6。
- 签署后以 `docs/CONTRACT.md` v1.1 为准（若尚未合并，以签署记录 + `docs/CONTRACT-v1.1-DRAFT.md` 为准）。

## 1. T1.5a · 纯内部 ports 类型（可先行）

**目标**：在 `src/qq/types.ts` 追加**不依赖线上形状**的冻结内部接口（只定义类型，不实现行为）：

```ts
export interface ReserveInput {
  eventId: string;
  sessionKey: string;
  role: 'user';
  text: string;
  speaker: string | null;
  quote: { fromName: string; text: string } | null;
  isAtBot: boolean;
  at: number;
}

export interface RecoveredReceipt {
  receipt: Receipt;
  record: import('../memory/store.ts').RawRecord;
}

export type ReserveResult =
  | { kind: 'new'; receipt: Receipt }
  | { kind: 'duplicate'; receipt: Receipt }
  | { kind: 'ignored'; reason: 'foreign_l0' | 'before_receipts_since' };

export interface ReceiptStore {
  reserve(input: ReserveInput): ReserveResult;
  markProcessing(eventId: string): boolean;
  markStoredOnly(eventId: string): boolean;
  markDone(eventId: string, sentIndexes: number[], failedIndexes: number[]): boolean;
  markFailed(eventId: string, reason: string): boolean;
  bootstrapFromL0(): { recovered: RecoveredReceipt[]; aborted: string[] };
  prune(now: number): void;
}

export type SendOutcome = 'all_sent' | 'partial' | 'none_sent' | 'ambiguous_failure';

export interface SendResult {
  outcome: SendOutcome;
  sentIndexes: number[];
  failedIndexes: number[];
  retryable: boolean;
  retryAfterMs: number | null;
  reason: string | null;
}

export interface ReplyPlan {
  messages: string[];
}
```

- **允许改**：`src/qq/types.ts`。
- **禁止**：其他任何文件；不得改现有 `Receipt`/`ReceiptStatus`/`ReceiptOutcome`/`WakeItem`/`WakePacket`/`InboxItem`。
- **明确不做**：不定义 `HookEvent`、`QqTarget`、`QqSendOptions`、`QqSender` 或其他 `/hook`、`/send` 线上形状；这些放入 T1.5b，等 v1.1 签署与 fixtures 同步后补齐。
- **T1.5a-r 增量（R3 duplicate 边界）**：`ReserveResult` 增加 `ignored` 变体，禁止用伪造 `Receipt` 表达外来/水位前 L0；该变体不对应 Receipt 状态，hooks 映射 200 零副作用。
- **必查**：`npm run typecheck` 零错误；`npm test` 保持执行时全量基线全绿（T1.5a 不新增/不删除测试；若 T1.6 已落地，按实际基线计数）。
- **安全约束**：只增加类型声明与纯类型常量；不得引入运行时逻辑、`any`、线上契约类型或新的导出面。
- **停止条件**：与 `docs/P2-INTERFACES.md` §1/§3/§4 有任何冲突 → 停下报告，不要自行改冻结稿。
- **回执**：diff + typecheck/test 输出。

## 1b. T1.5b · 传输端口类型（v1.1 签署后）

**目标**：在 `src/qq/types.ts` 追加 `QqTarget`、`QqSendOptions`、`QqSender`；字段以签署版 CONTRACT §3/§5 派生，不新增发送语义。

**允许改**：`src/qq/types.ts`。**禁止**：其他任何文件、改 T1.5a 已冻结接口。
**必查**：`npm run typecheck` 零错误；`npm test` 保持全绿。
**停止条件**：签署版契约与 `docs/P2-INTERFACES.md` 冲突；需要改线上形状 → 停下报告。
**回执**：diff + typecheck/test 输出。

## 1c. T1.6 · EventStore 三态写入与 L0 恢复元数据

**目标**

1. 在 `src/memory/store.ts` 增加与 `append()` 并存的三态 API：

```ts
export type AppendResult =
  | { kind: 'inserted'; record: RawRecord }
  | { kind: 'duplicate'; record: RawRecord }
  | { kind: 'write_error'; message: string };

appendResult(input: AppendInput): AppendResult;
```

2. `append()` 保持 P0/P1 的现有行为作为兼容包装：`inserted` 返回 record；`duplicate` 与 `write_error` 返回 `null`，写失败仍只告警一次、不打断 CLI。
3. `RawRecord` / `AppendInput` 增加可选 `isAtBot?: boolean`；作为 L0 独立元数据保存，不拼进 `text`。旧记录缺省仍兼容读取。
4. **T1.6b 增量（R3 duplicate 边界）**：`appendResult()` 的 `duplicate` 必须携带已有 `RawRecord`，供 T2 在 Receipt 缺失时判断 L0 来源；不得只返回 id 或再读盘。T2 只按该 record 决定 `new` / `ignored` / 503。

**允许改**：`src/memory/store.ts`、`tests/unit/store.test.ts`。
**禁止**：其他任何文件；不改 `RawRecord` 的 id/src/sessionKey/t/role/text 含义；不改 CLI 默认行为。
**必读**：`src/memory/store.ts`、`tests/unit/store.test.ts`、`src/agent/loop.ts` 的 `append` 调用、`docs/P2-INTERFACES.md` §1。
**必测**

- 新 id：`inserted` + 记录可读回；
- 重复 id：`duplicate` 且携带既有 record，不产生第二行；`append()` 仍返回 `null`；
- 写入失败：`write_error`，与重复明确区分；旧 `append()` 仍返回 `null` 且只告警一次；
- `isAtBot` 落盘/读回；旧记录缺该字段仍可读取并参与去重；
- 超长原文完整落盘不变。

**停止条件**：需要改 `append()` 的 CLI 语义；需要改其他模块/存储格式导致 P0/P1 回归；需要新依赖 → 停下报告。
**回执**：diff、typecheck/test、三态用例结果。

## 2. T2 · Hook、Receipt、会话映射与权限

**目标**

依赖的冻结类型（只读，不得在 T2 修改）：

```ts
type AppendResult =
  | { kind: 'inserted'; record: RawRecord }
  | { kind: 'duplicate'; record: RawRecord }
  | { kind: 'write_error'; message: string };

type ReserveResult =
  | { kind: 'new'; receipt: Receipt }
  | { kind: 'duplicate'; receipt: Receipt }
  | { kind: 'ignored'; reason: 'foreign_l0' | 'before_receipts_since' };
```

1. `src/qq/wire.ts`：定义签署版 `/hook/message` 线上类型（`HookEvent`/`HookSource`/`HookSender`/`HookQuote`），只做 wire shape，不写 OneBot。
2. `src/qq/receipts.ts`：实现 `ReceiptStore`（冻结稿 §1）：
   - `reserve` = **同步「检查 Receipt + 写 L0 user 原文 + 写 received」不可交错临界区**（单进程内不得有 await）；`eventId` 即 L0 记录 `id`；使用 T1.6 的 `appendResult()` 区分 `inserted`/`duplicate`/`write_error`，写失败必须抛出或返回失败，调用方不得 ACK；
   - Receipt 已存在 → `duplicate`；Receipt 已从内存 prune 但持久化 tombstone 为终态 → 仍按 `duplicate`；Receipt 缺失时：
     - `appendResult=inserted` → 写 `received` 并返回 `new`；
     - `appendResult=duplicate` → 用返回的既有 L0 判定：`src==='qq' && role==='user' && Date.parse(t)>=receiptsSince` 才补建 `received` 并返回 `new`；CLI/assistant 或早于水位 → `ignored`，200 零副作用；记录缺失/无效或 `t` 无法解析 → 抛出/失败，调用方 503；
     - `appendResult=write_error` → 抛出/失败，调用方 503。
   - `bootstrapFromL0()`：启动时把遗留 `processing` 置 `aborted`，扫描 L0 用户记录补建缺失 Receipt，返回 `{recovered: RecoveredReceipt[], aborted}`；必须在监听 `/hook` 前完成，失败则启动失败；
   - **首次启用水位**：首次启用时必须先持久化 `receiptsSince`（毫秒）；无历史 Receipt 时取当前时间；已有 Receipt/日志但缺水位则启动失败，不猜测。水位跨重启不重置。
   - **恢复过滤**：`bootstrapFromL0()` 只处理 `record.src === 'qq' && record.role === 'user' && Date.parse(record.t) >= receiptsSince`；更早的 QQ L0 只作记忆/去重事实，不回放；CLI L0 永不进入 QQ Receipt 恢复。恢复分流时 `isAtBot` 只认严格 `=== true`；缺失、非布尔、`"yes"`、`1`、`null` 等一律按 `false`，私聊不受该字段影响。
   - **终态 tombstone**：`done/failed/aborted` 的持久化 Receipt 记录必须保留；`prune()` 只清内存缓存，不得删除/压缩掉持久化终态记录；`bootstrapFromL0()` 先排除 terminal Receipt，再判断 L0-only。
   - 状态迁移：`received → processing → done/failed`、`received → done(stored_only)`、`processing → aborted`（仅重启恢复）；
   - `processing` 必须在**首次调用 provider 前**持久化；`done/failed/aborted` 终态不自动重试；
   - 去重默认 10 分钟（`dedupeTtlMs`，下限 6 分钟），重启后从 L0 重建；终态易失条目可按 TTL `prune`；
   - 持久化格式自定（建议 `state/qq-receipts.jsonl` 或 JSON），人类可读、坏行可跳过；Receipt 写入失败不得返回 200。
3. `src/qq/session-map.ts`：`private:<qqId>`/`group:<id>`；持久化 `state/qq-sessions.json`；权限顺序：`denyPrivate/denyGroups`（403）> owner（`private:<ownerQQ>`）> `allowGroups`（聊天档）> 静默忽略。被拒/忽略的消息**不建会话、不落 L0、不入队、不唤醒**。
4. `src/qq/hooks.ts`：`node:http` 服务，`POST /hook/message`、`GET /health`；顺序 **token(401) → 形状(400) → 权限(403/静默) → reserve(去重+持久化) → 200**；`64KB` 超限 413；持久化失败 503；重复 eventId 返回 200 但零副作用；`GET /health` 免 token，返回 `{name,version,ok,hookPort}`。
5. `src/qq/endpoint.ts`：监听成功后原子写 `runtimeDir/ds-memory.endpoint.json`（形状见签署版 §5.2），不含 token；正常关闭且 `instanceId` 匹配时删除；绑定失败（EADDRINUSE/EACCES）回退 `0` 并 warn。

**允许改**：`src/qq/{hooks,receipts,session-map,endpoint,wire}.ts`、`tests/unit/{receipts,session-map}.test.ts`、`tests/integration/hooks.test.ts`。
**禁止**：`docs/**`、`tests/contract/**`（只读）、`src/main.ts`、`src/agent/**`、`src/provider/**`、`src/memory/**`、`src/qq/{types,client,discovery,reply,turn,agent-registry,inbox,batch,wake}.ts`、`package.json`、任何 git 写操作。
**必读**：签署版 CONTRACT §2/§4/§5/§6、`docs/P2-INTERFACES.md` §1、`docs/P2-TASK-BREAKDOWN.md` §5-T2/§7、`docs/DECISION-LOG.md` G1/G3/G6 + 回环端口治理、`src/qq/types.ts`、`src/config/load.ts`、`src/memory/store.ts`、`tests/contract/README.md`。
**必测**

- `401`（token 错）、`400`（缺失/错类型）、`403`（黑名单）、`413`（>64KB）、`503`（持久化失败注入）与 `200`。
- 权限顺序：黑名单 > owner > 白名单群 > 忽略；陌生私聊零会话/零 L0/零唤醒。
- 同 eventId 串行并发/跨重启不重复写 L0、不入队；重复返回 200 零副作用。
- L0 已落盘但 Receipt 缺失且记录为可恢复 QQ user：重启 `bootstrapFromL0()` 补建并恢复一次入队；运行时重试同一 eventId 也补建一次；不得静默吞掉。
- `received` 已持久化但尚未入队时重启：恢复入队一次；`processing` 一律 `aborted`，不补投。
- Receipt 为 `received` 但找不到 L0 记录：启动失败并告警，不得入队。
- CLI L0（`src='cli'`）即使 id 看似 eventId 也不得补建 QQ Receipt、不入队。
- 首次启用前已有的 QQ L0（早于 `receiptsSince`）不补建、不回放；水位持久化后重启不得重置。
- 终态 Receipt 经 `prune()`（含超过 TTL）后重启不恢复；pending `received` 不被 prune 丢弃。
- 终态 Receipt 被内存 prune 后再次收到同一 eventId：仍按 duplicate，返回 200 零副作用，不得补建或唤醒。
- 运行时 Receipt 缺失、既有 L0 为 CLI/assistant：返回 `ignored`，200 零副作用，不建 Receipt、不入队、不唤醒。
- 运行时 Receipt 缺失、既有 QQ user L0 早于 `receiptsSince`：返回 `ignored`，200 零副作用，不补建、不回放。
- 运行时 Receipt 缺失、L0 查不到/无效：返回失败/抛错，hooks 映射 503，不得 ACK。
- 运行时 Receipt 缺失、L0 存在但 `t` 无法解析：返回失败/抛错，hooks 映射 503，不得 ACK。
- `write_error` 脱敏：分别注入 Windows（如 `C:\...`）与 POSIX（如 `/tmp/...`）绝对路径，断言 503 响应、日志、`failureReason` 和 `/status` 均不含路径，只含固定文案或错误码。
- 群消息 L0 带 `isAtBot=false` 的恢复：T6 服务层按 `groupWake` 分流，非 `mention` 直接 `stored_only`，不唤醒；`isAtBot=true` 才恢复群回合。
- `received → processing` 在 provider 前；模拟重启把 `processing → aborted`，不补投。
- 端点文件原子写、无 token、正常关闭删除、pid/instanceId 语义。
- 用 `tests/contract/hook/*.json` 的 `payload/expect` 驱动断言（不得改 fixtures）。

**安全约束**：只监听回环；token 比较/错误响应不回显 token；持久化失败不得 ACK；权限拒绝不得落 L0/入队/唤醒；日志不得含完整消息正文。`appendResult.write_error.message` 可能含底层绝对路径，禁止原样写入 HTTP 响应、日志或 `failureReason`；对外/日志只记录固定文案或错误码。

**停止条件**：fixture 与签署版契约不一致；需要改权威契约/冻结稿；需要改禁止路径；需要写 OneBot；T1.6 三态 API 不可用 → 停下报告。
**回执**：改动、typecheck/test、fixture 结果、未做项。

## 3. T5 · QqClient、发送失败矩阵与服务发现

**目标**

1. `src/qq/client.ts`：实现 `QqSender`（冻结稿 §4）：
   - `send(target, messages, opts)` → `POST /send`，带 `X-Memory-Token`，`node:http` 的 `fetch` 内置实现，超时用 `sendTimeoutMs`/`AbortSignal`；
   - 严格按 v1.1 §3.3 绑定 HTTP 状态与响应体：`200` 全成功或非 429 应用级失败；`429` 首失败 `rate_limited`；`400/401/413` 请求被拒；`500/503` 网关内部错误；非法响应体按歧义失败；
   - 仅 `429` 且 `failed[0].reason === "rate_limited"` 可重试；重试子集为 `failed[0].index` 到原请求末尾的全部原始 index（含 `not_attempted` 尾部），最多 2 次，保持原序；
   - `X-Retry-After-Ms` 优先、>30s 放弃、缺失 2s/10s；重试子包局部 index 必须映射回原始 index；
   - 重试子集首条原始 index > 0 时清空 `replyToMessageId`；首条为 0 时保留；整批从未发送时保留；
   - 重试后 `sentIndexes` 累计所有实际送达的原始 index，最终 `outcome` 按累计结果判定；`retryable` 在超过 2 次或等待 >30s 后为 false；
   - 非 429 应用级失败：保留 `sent` 前缀，`partial`/`none_sent`，不重试；超时/网络/其他 5xx/非法响应 → `ambiguous_failure`，不重发；400/401/413 → `none_sent`，不重试；
   - 不拆句、不定义线上请求形状之外的行为、不引 `sendId`。
2. `src/qq/discovery.ts`：网关端点发现（签署版 §5.3）：
   - `qq.gatewayUrl` 非空 → 直接用；
   - 空 → 读 `runtimeDir/qq-gateway.endpoint.json`，校验 `v/name/host/port/pid`；连接失败或文件变化时重读；缺失/pid 已死按离线处理；
   - 只使用字面量 `127.0.0.1`，不接受 `localhost`/非回环。
3. `health()`：`GET /health`（免 token），解析 `{ok, online, selfQqId}`；失败只告警不抛致命。

**允许改**：`src/qq/{client,discovery}.ts`、`tests/unit/{client,discovery}.test.ts`。
**禁止**：`docs/**`、`tests/contract/**`（只读）、`src/main.ts`、`src/agent/**`、`src/provider/**`、`src/memory/**`、`src/qq/types.ts`、其他 qq 文件、`package.json`、任何 git 写操作。
**必读**：签署版 CONTRACT §3/§4/§5、`docs/P2-INTERFACES.md` §4、`docs/P2-TASK-BREAKDOWN.md` §5-T5/§7、`docs/DECISION-LOG.md` G4/G6 + 回环端口治理、`src/qq/types.ts`、`src/config/load.ts`。
**必测**（假网关 `node:http`，不触真实 QQ）：

- 全成功、部分成功、`failed` index 映射、429 响应头优先、缺失走 2s/10s、>30s 放弃、重试最多 2 次；`not_attempted` 尾部随 429 重试。
- 429 状态但 `failed[0]` 非 `rate_limited`、200 状态却首失败 `rate_limited`、缺 `failed`/数量不符 → `ambiguous_failure`，不重试。
- `messages=[]`：本地短路返回 `none_sent`、reason `empty_messages`，不发请求；不得返回 `all_sent`。
- 200 非 429 部分失败（`timeout`/`http_5xx`）保留 `sent` 前缀且不重试；400/401/413 不重试；超时/网络/5xx/非法响应 `ambiguous_failure` 且只调用一次；不整包重发。
- 引用语义：重试子集首条原始 index >0 时 `replyToMessageId=null`；首条为 0 时保留。
- 发现：合法端点文件、缺失、pid 已死、非回环、端口越界、显式 URL 覆盖。
- 无 `sendId`、无拆句、无 OneBot。

**安全约束**：token 只放请求头且不落日志；只连接字面量 `127.0.0.1`；不得信任响应中的 `sent` 顺序；非法/歧义响应不得重发。

**停止条件**：需要改 `SendResult` 冻结形状；需要线上请求形状之外的契约变更；需要改禁止路径 → 停下报告。
**回执**：改动、typecheck/test、失败矩阵用例清单、未做项。

## 4. T4c · ReplyPlan、实际送达收尾与整回合编排

**目标**

1. `src/qq/reply.ts`：`buildReplyPlan(text, { maxPerTurn })`：
   - 产出有序 `ReplyPlan { messages: string[] }`；空文本 → `messages: []`；
   - 按 `maxPerTurn` 截断并记日志；不发送、不触网络。
2. `src/qq/turn.ts`：`runQqTurn(...)` 整回合编排（依赖注入，便于测试）：
   - 输入：`registry`、`sessionKey`、`wake: WakePacket`、`sender: QqSender`、`receipts: ReceiptStore`、`target: QqTarget`、`maxPerTurn`、`signal`；
   - 在 `registry.runExclusive(sessionKey, async agent => ...)` 内完成**模型 + 发送 + 收尾**：
     1. 对 `wake.items` 的每个 `eventId` 调 `receipts.markProcessing`（首次 provider 前）；失败则不调 provider；
     2. `agent.runTurn(wake.modelText, { writeUserL0: false, writeAssistantL0: false, signal })`；
     3. `buildReplyPlan(result.text, { maxPerTurn })`；空 → 不发送；
     4. `sender.send(target, plan.messages, { signal })` → `SendResult`；
     5. 按 `sentIndexes` 取实际送达的 `plan.messages`，按原序拼成单个 assistant 文本，`agent.commitAssistant(delivered)`；无送达则跳过；
     6. 每个 eventId：`sentIndexes.length > 0` → `markDone(sentIndexes, failedIndexes)`；零送达/歧义 → `markFailed(reason)`；部分送达 → `done`（终态，不自动重试）；
   - 不得双写 user L0；不得把未送达内容写入 assistant L0/history；不得整包重发。

**允许改**：`src/qq/{reply,turn}.ts`、`tests/unit/{reply,turn}.test.ts`。
**禁止**：`docs/**`、`tests/contract/**`、`src/main.ts`、`src/agent/**`、`src/provider/**`、`src/memory/**`、`src/qq/types.ts`、其他 qq 文件、`package.json`、任何 git 写操作。
**必读**：`docs/P2-INTERFACES.md` §0/§3/§4、`docs/P2-TASK-BREAKDOWN.md` §5-T4、`docs/DECISION-LOG.md` G4、`src/agent/loop.ts`（`writeUserL0/writeAssistantL0/commitAssistant`）、`src/qq/agent-registry.ts`（`runExclusive`）、`src/qq/types.ts`、`src/qq/wake.ts`。
**必测**

- `buildReplyPlan`：单句/多句/空文本/超 `maxPerTurn` 截断与日志。
- 全成功：assistant L0/history 为全部送达内容；`markDone`。
- 部分成功：只把 `sentIndexes` 对应内容写入 assistant L0/history；未送达不落盘；`markDone`；不整包重发。
- 零送达/歧义：不写 assistant L0/history；`markFailed`；不重试。
- 同 session 串行（发送阻塞时下一轮不启动）；不同 session 可并行（用 `runExclusive` 现有语义）。
- 不双写 user L0；`wake.omittedEventIds` 不进入本轮 Receipt 状态迁移。

**安全约束**：只把实际送达内容写 assistant L0/history；日志不得包含消息全文或 token；不直接触网关/QQ，只经 `QqSender`。

**停止条件**：需要改 `ReplyPlan`/`SendResult`/`Receipt` 冻结形状；需要改 `src/agent/**`（seam 不足）；需要改禁止路径；崩溃恢复语义未确认 → 停下报告。
**回执**：改动、typecheck/test、送达/未送达断言清单、未做项。

## 5. T6 · 常驻装配、锁、健康与全链路（T2–T5 已通过）

> T6 分两段交付：**T6a 先补三项加固**；T6a 定向测试通过后，**T6b 再做 service/lock/main/serve 装配与全链路**。
> T6b 不得在 T6a 未通过前开工；T6a 的三项加固写路径互不重叠，可并行派给不同 Worker；T6b 由同一 Worker 连续完成；Tester 分段复核。

### 5.1 T6a · 三项加固（先做）

#### A. `qq.gatewayUrl` 与发现校验统一收紧

- `src/qq/discovery.ts` 的 `validateExplicitGatewayUrl()` 改为唯一 canonical 判定，`src/config/load.ts` 与 `QqClient` 必须复用它，禁止三处各写一套。
- 非空只接受：`http://127.0.0.1:<port>`。
  - 协议必须 `http:`，`https:` 一律拒绝；
  - hostname 必须字面量 `127.0.0.1`，拒绝 `localhost`、IPv6、任意主机名；
  - 必须显式端口，整数 `1..65535`；缺省端口拒绝；
  - pathname 必须 `/`；`search`、`hash` 必须为空；
  - 禁止 username/password（userinfo）。
- 空串仍表示端点发现模式，由 `GatewayDiscovery` 读 `qq-gateway.endpoint.json`。
- 配置错误只报字段名与固定原因，绝不回显原始 URL（可能含 token/主机信息）。
- 旧测试中“接受 `https://127.0.0.1`”的断言必须改为拒绝；不得为了兼容保留 https。

#### B. assistant L0 前校验 `SendResult` index 不变量

- 在 `src/qq/turn.ts` 的 `commitAssistant` 之前增加纯本地校验，不信任 `QqSender`：
  - `sentIndexes`、`failedIndexes` 必须是整数数组；
  - 每个 index 必须在 `0..plan.messages.length-1`；
  - 各自数组内不得重复；两个数组不得交叉重叠；
  - 非 `ambiguous_failure` 时，两者并集必须恰好等于请求的全部原始 index 集合；
  - 追加 outcome 一致性：`all_sent` 必须 `failed=[]` 且全送达；`partial` 必须两边都非空；`none_sent` 必须 `sent=[]` 且 failed 覆盖全部。
- 任一不变量违例 → 在本地归一化为 `{ outcome:'ambiguous_failure', sentIndexes:[], failedIndexes:[], retryable:false, retryAfterMs:null, reason:'invalid_send_result' }`：
  - 不得调用 `agent.commitAssistant()`；
  - 不得写 assistant L0/history；
  - 必须对全部 eventId `markFailed`，固定原因 `发送结果非法`（不得带原始 index 数组或消息正文）。
- `ambiguous_failure` 本身不要求并集完整（QqClient 对歧义结果允许 `failedIndexes=[]`），但仍按零送达处理。
- 合法 partial 仍按原逻辑只提交 `sentIndexes` 对应内容；不得因加固改变 T4c 已通过的送达语义。

#### C. 日志/状态路径脱敏

- 在 `src/util/redact.ts` 增加可测试的路径脱敏函数（名称自定），至少覆盖：
  - Windows 盘符绝对路径（`C:\...`、`C:/...`）；
  - UNC 路径（`\\server\share\...`）；
  - POSIX 绝对路径（`/tmp/...`、`/var/...`）；
  - 不得误伤 `http://127.0.0.1:3000/...` 这类 URL。
- T6a 只交付可复用的路径脱敏函数与单元测试；T6b 在 serve 装配中把它接到 `EventStore`、`ReceiptStore`、`SessionMap`、`HookServer`、`FactsStore`、`SelfNoteStore`、`Agent` 的 `onWarn`，并保证 `EventStore.onWarn` 绝不直接转发 `appendResult.write_error.message`。
- `/status` 只返回固定字段和计数，不返回原始异常、错误 message、token、消息正文、绝对路径（T6b 实现并测试）。
- 必测：T6a 覆盖 Windows/UNC/POSIX 路径与 URL 不误伤；T6b 再断言日志、503 响应、`failureReason`、`/status` 输出均不含原路径；非 win32 实机未验证记为低风险。

**T6a 允许改**：`src/qq/{discovery,client,turn}.ts`、`src/config/load.ts`、`src/util/redact.ts`、`tests/unit/{config,discovery,client,turn,redact}.test.ts`。
**T6a 禁止**：`src/main.ts`、`src/qq/{service,lock,hooks}.ts`、`docs/**`、`tests/contract/**`、任何 git 写操作。
**T6a 停止条件**：需要改 `SendResult`/`QqSender` 冻结形状；需要放宽 https；需要改禁止路径 → 停下报告。

### 5.2 T6b · service/lock/main/serve 装配

**目标**

1. `src/qq/lock.ts`：单实例锁 `{pid, instanceId, startedAt}`，路径固定为 `<stateDir>/ds-memory.lock`。
   - 原子发布：先把完整 JSON 写入同目录临时文件，再用 `linkSync(temp, lockPath)`（或等价的不覆盖原子发布）创建最终锁；**不得先创建空锁文件再写入**，避免并发实例把“已创建但尚未写入”的空文件误判为 stale。
   - 已存在时读取并校验；`link` 返回 EEXIST 才进入 stale/held 判定。
   - `pid` 存活 → 拒绝启动，绝不抢锁；PID 已死、文件损坏或字段非法 → 视为 stale，只清 stale 后重试一次。
   - 关闭时只删除 `instanceId` 与自身一致的锁；不得误删其他实例锁。
   - `isPidAlive` 可注入，便于测试。
   - 另按 CONTRACT §5.4 检查 `runtimeDir/ds-memory.endpoint.json`：`pid` 存活则拒绝启动；stale 允许继续。
2. `src/qq/service.ts`：常驻编排，启动顺序固定：
   - 获取单实例锁；
   - 构造依赖（EventStore/ReceiptStore/SessionMap/inbox/registry/discovery/sender）；
   - `receipts.bootstrapFromL0()`；失败则释放锁并启动失败；
   - 恢复分流：
     - 私聊：按当前权限重新判定；仍允许则入队，不允许则 `markStoredOnly`；
     - 群：`groupWake='all'` 全部入队；`groupWake='mention'` 仅 `record.isAtBot === true` 入队，其余 `markStoredOnly`；缺失、非布尔、`"yes"`、`1`、`null` 一律按 false；
     - 不再允许/无法解析的 sessionKey → `markStoredOnly`，不入队；
   - 上述完成之后才 `HookServer.start()`；hook 启动失败则释放锁；
   - 运行期 `onReserved` 只把 `kind='new'` 转成 `InboxItem` 入队；duplicate/ignored 零副作用。
3. 调度与回合：
   - 每 session 一个窗口定时器；窗口自该 session 首条入队起算 `batchWindowMs`，不因后续消息重置；
   - 忙时到达的新消息：记录其首条入队时间；当前批次结束后，下一批必须等待「该时间 + batchWindowMs - now」的剩余窗口，不得直接 0ms 抢跑；仅由 omitted 重新入队的旧消息不重新等待完整窗口，队列中同时有新旧消息时以新消息的剩余窗口为准；
   - `inbox.takeNextBatch()` → `buildWakeBatch({groupWake, limits})`；
   - `storedOnly` → 逐条 `markStoredOnly`；
   - `packet=null` 且无 omitted → release；有 omitted → `requeueFront` 后立即安排下一批；
   - `packet` 非空 → `runQqTurn()`；完成后把 omitted 按原序 requeue，再 release；队列仍有消息则立即安排下一批；
   - 同一 session 不得并发两个回合；不同 session 可并行；回合异常要先把本批 omitted 按原序 requeue（原文不丢），再 release，并尽力 `markFailed`，不得让服务崩溃。
4. 网关发现与健康：
   - 发送时每次解析端点；显式 URL 直接使用；端点变化或连接失败后下一次发送重新发现；
   - 发现离线时返回 `none_sent` + `reason='gateway_offline'`，不得抛未捕获异常；
   - `healthIntervalMs` 轮询 `/health`；失败只告警，不退出；恢复后自动继续；
   - 健康告警不得含 token、绝对路径或消息正文。
5. `/status`：
   - 在 `HookServer` 增加 `GET /status`，必须校验同一 `X-Memory-Token`，错误 401；
   - 只返回最小可观测信息：`ok`、`pid`、`uptimeMs`、`hookPort`、`gateway`（online/offline/unknown）、`sessions`、`receipts`、`inbox`（pending/busy 计数）、`recovered`/`aborted` 计数；
   - 不返回 token、消息全文、原始异常、`failureReason`、绝对路径。
6. `src/main.ts` + `package.json`：
   - `--serve` 分支：不得创建 readline、不得进入 CLI 循环；
   - `qq.enabled=false` 时 `--serve` 以固定错误退出 1；
   - CLI 默认行为、banner、`/status`、`/exit` 等保持完全兼容；
   - 增加 `"serve": "node src/main.ts --serve"`。
7. 关闭：
   - SIGINT/SIGTERM → 标记 stopping → 清定时器 → abort 在途回合并等待收尾（含 `healthInFlight`）→ 停止 hook → 释放锁；
   - 关闭流程幂等；重复调用不得删他人锁。

**T6b 允许改**：`src/main.ts`、`src/qq/{service,lock,hooks}.ts`、`package.json`、`tests/unit/lock.test.ts`、`tests/integration/{hooks,serve}.test.ts`。
**T6b 禁止**：`docs/**`、`tests/contract/**`、`src/agent/**`、`src/provider/**`、`src/memory/**`、`src/qq/{types,receipts,session-map,inbox,batch,wake,client,discovery,turn,reply,wire,endpoint}.ts`、`src/config/load.ts`、`src/util/redact.ts`、任何 git 写操作。
**T6b 必读**：`docs/P2-TASK-BREAKDOWN.md` §5-T6/§4.5、签署版 CONTRACT §5、`docs/DECISION-LOG.md` G5/G6 + 回环端口治理、T6a 实际落盘接口。

**T6b 必测**

- 锁：首次获取、活 PID 拒绝、死 PID stale 清理、损坏文件清理、关闭只删本实例、重复关闭幂等；两个实例并发只允许一个。
- stale 清理必须比较「清理前读到的锁内容」与「rename 后实际拿到的文件内容」；不一致说明别的实例已发布新锁，必须还原并拒绝，不得删除新锁。读取既有锁失败（如 EACCES）必须 fail closed，不得当作 stale 删除。
- stale 清理与 release 必须用一个短持有的 cleanup lease（同目录独立文件，原子 link 发布）串行化；lease 持有期间重读主锁再决定清理/发布/释放。lease 自身只在 pid 死亡/内容损坏时清理，活 PID 等待或拒绝。还原失败（目标已被第三方占用）时不得删除 `.stale`/`.release` 文件，必须保留现场并 `lock_held`。
- 锁原子性：最终锁文件一经出现必须是完整 JSON；不得存在“空文件被另一实例当 stale 清掉”的路径；`link` 不可用时 fail closed，不得回退到空文件 `wx`。
- 端点：已有存活 `ds-memory.endpoint.json` 拒绝启动；stale 允许覆盖。
- 启动顺序：`bootstrapFromL0` 完成前 hook 不监听；bootstrap 失败退出且释放锁。
- 恢复分流：私聊入队；群 `mention` 仅严格 `isAtBot===true` 入队，其余 `stored_only`；`all` 全部入队；缺失/损坏值不唤醒；允许但仅保存的恢复消息也要登记 session map，避免状态漏计。
- 调度：窗口自首条起算、忙时新消息等待剩余窗口、同 session 串行、跨 session 并行、超限 omitted 重新入队不丢原文、storedOnly 不调用模型。
- 网关离线：发送返回 `none_sent/gateway_offline`，回合 `markFailed`，服务不退出；健康轮询失败只告警，恢复后继续。
- `/status`：无 token 401、错 token 401、正确 token 200，且响应不含 token/消息正文/原始异常/绝对路径。
- `/status` 的 status provider 若抛错：返回 500 + `{ok:false}` 固定响应，不得透出异常 message。
- 假网关全链路（`node:http`，不触真实 QQ）：
  - 成功：hook 200 → 合批 → 假 Agent/provider → `/send` → assistant L0 只含实际送达内容 → Receipt `done(replied)`；
  - 部分失败：只提交 sent 前缀，Receipt `done` 且 sent/failed index 正确；
  - 放弃：5xx/非法响应/超时 → 不写 assistant L0/history，Receipt `failed`；
  - 重复 eventId：200，不重复入队/唤醒/写 L0。
- CLI 回归：现有全量测试中的 CLI/P0/P1 用例必须保持全绿；`--serve` 分支不出现 `你 >` 提示、不读 stdin；`npm run serve` 脚本存在。
- 进程级：spawn `node src/main.ts --serve` 且使用 `qq.enabled=false` 的配置，断言固定错误、退出码 1、不进入 readline；完整假网关链路用 `startQqService` 直调（同一装配函数）验证，避免测试依赖真实 provider 网络。
- 不得为了测试新增 CLI 参数、配置根环境变量或改写 `config.example.jsonc`；如需临时配置，只能在测试临时目录内直调 service。

**T6b 安全约束**：只绑定/连接字面量 `127.0.0.1`；token 不落日志/状态/错误正文；不启动/停止 SnowLuma；不写 OneBot 协议；不新增依赖；不 commit/push。
**T6b 停止条件**：需要改公开 CLI/配置破坏兼容；需要新依赖；需要改冻结接口或禁止路径；锁/恢复语义无法在不改 T2 的前提下实现 → 停下报告。

## 6. 下发顺序与验收

1. **T1.5a/T1.5b**（内部/传输类型）与 **T1.6/T1.6b**（存储三态）已完成并通过独立复核。
2. **T2 / T5 / T4c 并行**（T2 需等 T1.6）→ 各自 typecheck + 全量测试；逐个独立 Tester 复核（不信任 Worker 自述）。
3. 任一缺陷 → 原 Worker 返工；返工后 Tester 定向复验。
4. **T6** → 假网关全链路 + CLI 回归 + 锁/健康验收。
5. 硬性门：typecheck 零错误；全量测试全绿（不删测试/不降阈值）；`tests/contract/**` 未被改动；无新依赖；无 commit。

## 7. 验收证据模板（每个 Worker 回执必须包含）

- 改动文件清单与每个文件的意图；
- `npm run typecheck` 输出；
- `npm test` 输出（文件数/测试数；重跑证据若有）；
- 新增/修订断言清单；
- 未做项与原因；
- 是否触碰禁止路径（应明确“无”）。

## 8. T6 收口记录（2026-11-04）

- **T6a PASS**：`gatewayUrl` 收紧为 `http://127.0.0.1:<显式端口>`；`SendResult` index 不变量在 assistant L0 前校验；`redactPaths()` 覆盖 Windows/UNC/POSIX 并在 serve 全链注入。
- **T6b PASS**：单实例锁（完整临时文件 + `linkSync` 原子发布 + cleanup lease 串行 stale 清理/release）、`bootstrapFromL0` 先于 hook、恢复分流、忙时剩余窗口、`/status` 鉴权与白名单字段、`--serve`、健康轮询、假网关 success/partial/abandon/duplicate。
- **证据**：`typecheck` 0 错误；`npm test` 27 files / **390 tests** 全绿；`contract:check` 25/25；HEAD 仍 `acf2a0f`，未 commit/push；`docs/CONTRACT.md` SHA-256 仍 `B7E2BA63D2DA231F162C9017A709EAA389581261DEF06E1661DB8E89071F4058`。
- **残余风险**：live cleanup lease 同步等待实测约 359ms（有界，但会拖慢启动/停止）；`release()` 在无法获得 live lease 时可能返回 false 但已移除自身锁；release 抢占会保留 `.release` artifact；定向 vitest 偶发 `Channel closed`（最终全量与指定重跑绿）；非 win32 未实机验证；真实 SnowLuma/QQ 联调未执行。
