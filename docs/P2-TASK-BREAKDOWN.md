# P2 脑侧任务拆分（修订版 · 已归档）

> 状态：**有条件通过**，已按评审七项修订后归档。
> 归档时间：2026-11-03。
> 2026-11-04 修订：qq-gateway 对 v1.1 提出 M1–M4 阻塞；R3 已 PASS，新增 duplicate 边界增量待快核。相关语义以 `docs/P2-INTERFACES.md` r3 与 `docs/P2-TASK-CARDS-T2-T5-T4C.md` 为准，并新增 T1.6/T1.6b。
> 交接基线：**76 条测试全绿（实测，非 75）**；T1.6b/T1.5a-r 后当前实测 **150 tests / 18 files 全绿**（2026-11-04）；`npm run typecheck` 零错误；运行期依赖仅 `zod`（总依赖 4，含 3 个 dev）。
> 纪律：本文件不提交 commit；组员开工仍受契约闸门约束；小群唤醒策略已按裁决 B 确定为 `groupWake="mention"`。

## 0. 评审结论（四条请示的明确回复）

- 拆分与依赖：**有条件通过**，按下文七项修订执行；不能原样下发。
- eventId 流程：修订提案已形成并提请 qq-gateway 架构侧会审，**闸门未解除**。
- 小群策略：**已裁决 B：默认仅 @/引用机器人唤醒，其余群消息只保存（`stored_only`）；`"all"` 仅作可切换配置。**
- 是否存档：**需要**。即本文件，记录 76 条实测基线、接口状态机、依赖闸门与本评审结论。

## 1. 七项修订（相对初版拆分）

1. **T1b 不得绕过契约闸门**：`HookEvent`、契约对应的 `QqTarget`/`SendResult` 属于契约派生类型，不得借「内部 types.ts」提前实现。
   - T1 只设计纯内部 `Receipt`/`WakePacket`。
   - 契约相关类型仅在 CONTRACT 修订会签后冻结。
   - `SendResult` 可先定义脑侧无关传输细节的 `sentIndexes`/`failedIndexes`/`outcome` 语义，但不得提前固定线上请求形状。
2. **Receipt 状态机精确定义**：见 §4.1，并落实「检查 eventId + 写 received」为非交错去重临界区。
3. **补齐 SendResult index 不变量**：见 §4.2。
4. **T4/T5 之间补充 ReplyPlan**：见 §4.3，T4 负责拆句，T5 只发送。
5. **L0 元数据不得污染原文**：见 §4.4。
6. **snowluma 不在 P2 删除**：保留旧字段解析兼容，P2 不消费、不新增逻辑，示例配置标记废弃；彻底删除另立小任务。
7. **T6 补充状态与锁语义**：见 §5-T6 与 §4.5。

## 2. 范围

**本阶段只做**（QQ 脑侧闭环）：

- hook 接收、token 鉴权、形状校验、权限判定、稳定 `eventId` 去重。
- 先持久化接收记录，再返回成功（`200 {ok:true}`）。
- 会话映射、收件箱、合批硬上限、忙时串行。
- 多会话 Agent、QQ 发送及失败矩阵。
- `serve` 常驻、健康检查、单实例锁、日志。
- CLI 与已通过 P0/P1 保持兼容。

**明确不做**：

- OneBot/SnowLuma 协议及进程管理。
- 图片、语音、合并转发、拍一拍动作。
- 本地语义检索（embedding）、数据库、消息队列、新增 agent 框架。
- owner 本机工具、网页 UI、多账号。
- `sendId`；commit。

P1.1 说话人标签已修复（`src/memory/retriever/bigram.ts:191`），本阶段只核验既有断言，不重复实现。

## 3. 配置基线（T1，纯内部配置可先行）

沿用现有 zod 风格。下列配置为「可先授权」部分；端口/发现/群唤醒的最终取值以
`docs/DECISION-LOG.md`「回环端口冲突治理」「裁决 B」为准（本表已同步，`4100/4200` 仅历史）。

| 配置 | 默认值 | 备注 |
| --- | --- | --- |
| `qq.enabled` | `false` | 关闭时 CLI 完全不受影响 |
| `qq.hookHost` | `127.0.0.1` | |
| `qq.hookPort` | `985` | 首选端口；绑定失败（EADDRINUSE/EACCES）回退 `0` 由系统分配 |
| `qq.hookToken` | `""` | `enabled=true` 时为空必须启动失败 |
| `qq.gatewayUrl` | `""` | 空 = 端点发现模式；显式 URL 覆盖优先 |
| `qq.runtimeDir` | 平台默认 | Windows `%LOCALAPPDATA%\DSH\runtime`；否则 `$XDG_RUNTIME_DIR/dsh`，缺失 `~/.dsh/runtime` |
| `qq.batchWindowMs` | `2000` | 自首条起算 |
| `qq.batchMaxMessages` | `12` | |
| `qq.batchMessageMaxChars` | `300` | 单条模型输入上限 |
| `qq.batchMaxChars` | `4000` | 总模型输入上限 |
| `qq.dedupeTtlMs` | `600000` | 覆盖网关 5 分钟重试窗口 |
| `qq.ownerQQ` | `0` | `enabled=true` 时非法（0）启动失败 |
| `qq.allowGroups` | `[]` | 白名单群 |
| `qq.denyPrivate` | `[]` | 黑名单私聊 → 403 |
| `qq.denyGroups` | `[]` | 黑名单群 → 403 |
| `qq.groupWake` | `"mention"` | @或引用机器人才唤醒；其余群消息只保存 `stored_only` |
| `qq.send.maxPerTurn` | `3` | |
| `qq.send.retryDelaysMs` | `[2000, 10000]` | 仅 429 且响应头缺失时使用 |
| `qq.send.sendTimeoutMs` | `10000` | `/send` 请求超时上限 |
| `qq.healthIntervalMs` | `30000` | 网关健康探测间隔 |
| `qq.snowluma` | 保留解析兼容 | **标记废弃**，P2 不消费、不新增逻辑 |

`enabled=true` 时：空 token、非法端口、非法 owner 配置必须启动失败；QQ 关闭时不得影响 CLI。

## 4. 接口状态机与不变量

### 4.1 Receipt 状态机（冻结）

```text
received ──→ processing ──→ done
                        └─→ failed
received ──→ done   （只保存、不唤醒）
processing ──→ aborted（仅重启恢复时发现）
```

语义：

- `received`：完整事件已持久化，尚未进入模型；**ACK 前必须达到此状态**。
- `processing`：**首次调用 provider 前**完成持久化；不是进入收件箱或开始合批时。
- `done`：处理完成并记录发送结果；部分送达也属终态，不自动重试。
- `failed`：模型、L0 或发送最终失败，本轮放弃，不自动重试。
- `aborted`：重启发现 `processing`，为避免重复回复终止补投。
- 群消息只保存不唤醒时，写完 L0 后直接从 `received` → `done(outcome=stored_only)`。
- 所有终态继续参与去重；重复 `eventId` 一律不重新入队。
- 「检查 eventId + 写入 received」必须是不可交错的去重临界区；并发测试不能只测顺序调用。
- 启动时执行 `bootstrapFromL0()`：`processing→aborted`，为 L0 中缺失 Receipt 的用户事件补建 `received`，再恢复入队；L0-only 不是普通重复。
- 首次启用持久化 `receiptsSince`；只恢复 `src=qq && role=user && t>=receiptsSince`，CLI L0 与水位前历史 QQ L0 不回放。
- 终态 Receipt tombstone 持久保留；`prune` 只清内存，不得让 done/failed/aborted 在重启后重新唤醒。
- 运行期 `appendResult=duplicate` 必须携带既有 L0；仅可恢复的 QQ user 记录补建 Receipt，CLI/assistant 或水位前记录返回 `ignored`，查不到/无效则 503。

### 4.2 SendResult index 不变量（脑侧语义，冻结）

- `failed.index` 按 **0 起始** 解释，并写入契约修订提案。
- 部分响应中，`sent.length + failed.length` 必须等于本次请求条数。
- 脑侧以「本次请求 index 集合减去 failed index」推导 `sentIndexes`，**不依赖 sent 数组顺序**。
- 重试子包的局部 index 必须映射回原始 index。
- index 越界、重复、遗漏或数量不一致均视为非法响应，按歧义失败放弃。
- 脑侧内部只定义 `sentIndexes`/`failedIndexes`/`outcome` 语义，不提前固定线上请求形状。

### 4.3 ReplyPlan（T4 → T5 接口，冻结）

- T4 负责产生有序 `ReplyPlan { messages: string[] }`。
- T5 只发送，不负责拆句。
- 空数组不调用 `/send`。
- 数组长度不得超过 `send.maxPerTurn`。
- 超出部分的截断策略由 T4 统一执行并记日志。
- T4 最终根据 `sentIndexes` 将实际送达内容写入 assistant L0/history。

### 4.4 L0 元数据不变量

- `text` 始终是完整原文，不拼接昵称、引用前缀或唤醒标签。
- 群说话人、quote 作为独立元数据字段。
- 群消息 `isAtBot` 作为独立元数据保存，供重启恢复时决定是否唤醒。
- 旧记录缺少元数据仍能读取（`isRawRecord` 向后兼容）。
- bigram 对群记录使用正确说话人标签，不能把所有群用户统一显示成含义不清的「你」。

### 4.5 状态与锁语义

- `/status` 若通过 HTTP 暴露，必须校验同一 token，且**不得返回 token、消息全文等敏感内容**。
- 至少包含：hook 端口、网关健康、会话数、权限计数、收件箱/Receipt 计数。
- 锁文件包含 `pid + instanceId + startedAt`。
- PID 存活时不得抢锁；仅确认进程不存在时才清理 stale lock。
- 关闭时只能删除属于本 `instanceId` 的锁，避免误删其他实例锁文件。

## 5. 任务拆分（修订版）

### T1 · 配置、内部类型与 L0 原文保真（纯内部，可优先授权）

- 1a 扩展 `src/config/load.ts` 的 `qq` schema（§3），含 `enabled=true` 校验；保留 `snowluma` 解析兼容并标记废弃。
- 1b 只设计纯内部 `Receipt`/`WakePacket`；**不定义** `HookEvent`/`QqTarget`/`SendResult` 的线上形状。
- 1c 消除 L0 截断：`store.append` 不再调 `truncateText`（`src/memory/store.ts:81`、`src/util/string.ts:2`），`RawRecord` 向后兼容扩展说话人/quote 元数据。
- 1d 更新 `config.example.jsonc`；`truncateText` 保留给模型输入/检索 chunk，解耦出 L0。
- 1e（T1.6/T1.6b，M3 恢复所需）新增 `appendResult()` 三态与 L0 `isAtBot` 元数据，duplicate 携带既有 record，保留 `append()` 的 CLI 兼容行为。
- 边界：不改权威 CONTRACT；不改 bigram 路线；不改变 CLI 默认行为；不重写存储层。
- 测试：旧配置兼容、非法新配置、超长原文完整落盘、同 id 去重、写失败可区分。

### T2 · Hook、接收去重、会话映射与权限（契约闸门后）

- 2a `src/qq/hooks.ts`：`node:http` 起 `POST /hook/message`、`GET /health`，token→形状→权限→去重→持久化→`200 {ok:true}`。
- 2b `src/qq/receipts.ts`：稳定 `eventId` 去重（TTL）、`received→processing→done/failed/aborted`、重启只补投「尚未进入模型」。
- 2c `src/qq/session-map.ts`：`private:<id>`/`group:<id>` 映射 + `state/qq-sessions.json` 持久化 + 权限顺序（黑名单 403 > owner > 白名单群 > 静默忽略）。
- 测试：400/401/403、权限顺序、重复事件零副作用、持久化失败不 ACK、重启去重、陌生私聊零副作用；CLI/assistant 与水位前 L0 不补建、缺失/无效 L0 返回 503。

### T3 · 收件箱、合批与唤醒包（Receipt/WakePacket 冻结后；群唤醒待裁决）

- 3a `src/qq/inbox.ts`：每会话 FIFO + 忙时排队（同 session 串行）。
- 3b `src/qq/batch.ts`：窗口自首条起算、条数/单条/总字符三重硬上限、超限进新批、原文不丢。
- 3c `src/qq/wake.ts`：生成有界唤醒包（群说话人、`[引用 张三：原文]`、省略提示均计入字符上限）；`groupWake="mention"` 控制群唤醒（`"all"` 可切换）。
- 测试：窗口内外、首条起算、12/300/4000 上限、忙时排队、群说话人与引用标签。

### T4 · Agent 多会话、ReplyPlan 与回合适配（ReplyPlan/SendResult 冻结后）

- 4a `src/agent/loop.ts` 小范围适配：外置 user L0 写入（避免双写），分离「原始记录 / 模型输入 / 发送收尾」。
- 4b `src/qq/agent-registry.ts`：`Map<sessionKey, Agent>`，同 session 串行、跨 session 并行。
- 4c 产生 `ReplyPlan`（拆句 + 截断 + 记日志），最终根据 `sentIndexes` 把实际送达内容写入 assistant L0/history。
- 测试：双私聊隔离、同会话串行、原文/唤醒包分离、无重复 L0、未送达不污染 assistant 历史、CLI 回归。

### T5 · QqClient 与发送失败矩阵（契约闸门后）

- 5a `src/qq/client.ts`：`fetch` 实现 `/send`（带 `X-Memory-Token`）、`health()`；只发送，不拆句。
- 5b 失败矩阵：全成功不重试；部分成功只重试 `failed` 原始 index；429 读 `X-Retry-After-Ms` 优先、缺失用 2s/10s、最多 2 次；超时/网络/5xx/非法响应体按歧义放弃；明确 4xx 不重试记配置错误；子包 index 映射回原始 index；不整包盲重试、不引 `sendId`。
- 测试：全成功、部分成功、index 映射、429 响应头优先、默认退避、5xx/超时/网络错误放弃。

### T6 · 常驻装配、状态与全链路验收（T2～T5 全部通过后）

- 6a `src/main.ts` 加 `--serve` 分支（不起 readline）、`package.json` 加 `serve` 脚本。
- 6b `src/qq/service.ts` 编排 hooks→inbox→batch→registry→send→finalize；`src/qq/lock.ts` 单实例锁（§4.5 语义）；网关健康轮询（失败只告警不退出）。
- 6c `/status` 按 §4.5 暴露最小可观测信息。
- 测试：重复启动拒绝、关闭清理、网关离线日志、假网关全链路、CLI 回归。

## 6. 模块接口依赖

**新增**：`src/qq/{types,hooks,receipts,session-map,inbox,batch,wake,client,service,agent-registry,lock}.ts`、`tests/contract/`。

**修改**：`src/config/load.ts`、`src/util/string.ts`、`src/memory/store.ts`、`src/agent/loop.ts`、`src/main.ts`、`package.json`、`config.example.jsonc`。

**依赖链**：`T1 → T2/T3`；`T2 与 T3 先对齐 Receipt`；`T4 ← T3（WakePacket）+ T5（SendResult）`；`T6 ← T2~T5`。

**必须先评审冻结、不允许两边各自实现后再对齐的接口**：

- `T2/T3` 的 `Receipt`（状态机 §4.1）。
- `T3/T4` 的 `WakePacket`。
- `T4/T5` 的 `SendResult`（§4.2）+ `ReplyPlan`（§4.3）。

## 7. 测试分配

- T1：`tests/unit/config.test.ts`（扩）、`tests/unit/store.test.ts`（修订截断断言为「超长完整落盘」）、`tests/unit/string.test.ts`（可选）。
- T2：新增 `tests/unit/session-map.test.ts`、`tests/unit/receipts.test.ts`、`tests/integration/hooks.test.ts` + `tests/contract/*.json` fixture。
- T3：新增 `tests/unit/inbox.test.ts`、`batch.test.ts`、`wake.test.ts`。
- T4：新增 `tests/unit/agent-registry.test.ts`、扩 `tests/unit/agent.test.ts`。
- T5：新增 `tests/unit/client.test.ts` + 假网关 fixture。
- T6：新增 `tests/unit/lock.test.ts`、`tests/integration/serve.test.ts`（假网关全链路）。

硬性断言：同 eventId 串行/并发/跨重启不重复唤醒；持久化失败不 ACK；三重上限；>4000 字 L0 完整、模型输入截断；私聊/群记忆隔离；部分成功只重试失败 index、歧义零重试；QQ 关闭 CLI 无回归、serve 不进 readline。**验收不得通过删除旧测试维持数量或凑绿**。

## 8. 依赖与开工条件矩阵

| 工作 | 开工条件 |
| --- | --- |
| L0 原文保真、兼容测试 | 拆分归档后可优先授权 |
| 纯配置、纯内部 Receipt/WakePacket | 不含最终群唤醒默认值及契约类型时可授权 |
| T2 Hook、契约 fixture | CONTRACT 会签后 |
| T3 普通私聊合批 | Receipt/WakePacket 接口冻结后 |
| T3 群唤醒、T4 群回合 | 小群策略裁决后 |
| T5 QqClient | CONTRACT 会签后 |
| T4 完整发送收尾 | ReplyPlan、SendResult 接口冻结后 |
| T6 全链路 | T2～T5 全部评审通过 |

## 9. CONTRACT 修订提案（会审中，未改权威文件）

提请 qq-gateway 架构侧会审：

1. 上报新增必传 `eventId: string`；同一原始事件重试时保持不变，缺失按 400。
2. `messageId` 继续只用于引用，不得代替 `eventId`。
3. `200 {ok:true}` 表示接收记录已持久化；重复事件返回相同成功响应，但不重复处理。
4. 临时持久化失败返回 503，网关在原 5 分钟窗口内重试；400/401/403 不重试。
5. 脑侧去重记录默认保留 10 分钟，覆盖网关 5 分钟重试窗口。
6. `failed.index` 明确为 0 起始；部分响应必须完整说明本次请求各 index 的成功或失败。
7. 429 优先使用 `X-Retry-After-Ms`，缺失才走脑侧默认退避。
8. 脑侧只重试 failed index；发送超时、网络错误、5xx、非法响应默认放弃。
9. 不引入 `sendId`。
10. 两侧先同步 CONTRACT 和 fixtures，再改实现；不设计「脑侧临时生成 eventId」的兼容 fallback。

在双方会签、总负责裁决前，**T2/T5 闸门不解除**。

## 10. 风险项

1. **契约闸门（最高）**：`docs/CONTRACT.md` 现用 `messageId`，P2 要求稳定 `eventId`；T2/T5 会签前不得开工，组长不得直接改权威文件。
2. **小群策略已裁决**：默认 `groupWake="mention"`（仅 @/引用唤醒，其余群消息 `stored_only`）；`"all"` 仅作可切换配置。裁决 B 已解除该闸门。
3. **L0 双写**：`src/agent/loop.ts:172-175` 现状由 Agent 自写 user L0，QQ 线必须改唯一写入方。
4. **L0 元数据向后兼容**：`RawRecord` 扩展不能破坏既有 76 条基线。
5. **崩溃歧义边界**：`processing` 状态迁移点（首次 provider 调用前）必须精确定义，否则重启补投造成重复回复。
6. **snowluma 残留**：保留解析兼容但 P2 不消费；彻底删除另立小任务。
7. **配置表缺项已补齐**：`hookToken/ownerQQ/allowGroups/denyPrivate/denyGroups/sendTimeoutMs/healthIntervalMs` 均入 §3，`sendTimeoutMs`/`healthIntervalMs` 的合理上限待 T1 定值。
8. **单实例锁崩溃残留**：`pid + instanceId + startedAt`，PID 存活不抢锁，仅确认进程不存在时清 stale lock。
9. **基线数字**：以实测 76 条为准。
10. **零新增依赖**：HTTP 服务必须用 `node:http`（内置），禁止引入 express/axios。

## 11. 裁决状态

1. CONTRACT v1.1 已同意会签（附合并条件）；待 qq-gateway R3 快核与总负责一次性签署。
2. 小群已裁决 B：默认仅 @/引用唤醒，其余群消息只保存；`"all"` 仅作可切换配置。
