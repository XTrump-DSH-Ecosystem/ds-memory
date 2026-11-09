# CONTRACT v1.1 评审回复（ds-memory 架构侧）

> 状态：工作文档，不构成契约，不 commit。
> 对象：qq-gateway `CONTRACT-V1.1-REVIEW.md` 的 M1–M4。
> 依据：`docs/DECISION-LOG.md`、`docs/CONTRACT-v1.1-DRAFT.md`（r2 + R3 增量）、`docs/P2-INTERFACES.md`（r3）、`docs/P2-TASK-CARDS-T2-T5-T4C.md`。

## 结论

四项阻塞均已有可实现的书面语义；qq-gateway R3 已 PASS，`duplicate` 来源判定与 `ReserveResult.ignored` 的增量快核也已 PASS。请由总负责一次性签署；`docs/CONTRACT.md` 尚未改。

## M1 · `/send` 状态与响应体绑定

- 全部成功：`200 {ok:true,sent}`。
- 非 429 的应用级部分/全部失败（`onebot_error`/`timeout`/`network_error`/`http_5xx`）：`200 {ok:false,sent,failed}`；保留 `sent` 前缀，脑侧不重试。
- 首失败为 `rate_limited`：`429 {ok:false,sent,failed}`，`failed[0].reason=rate_limited`，带 `X-Retry-After-Ms`；脑侧仅重试 `failed[0].index` 到末尾的尾部。
- `400/401/413`：`{ok:false}`，无发送副作用。
- 网关内部错误/无法可靠给出结果：`500/503`，脑侧按 `ambiguous_failure` 放弃。
- 非法响应体、数量/index 不变量不满足：脑侧按歧义失败放弃。
- `X-Retry-After-Ms` 是非负整数毫秒，网关返回实际等待，不把 >30s 截成 30s；脑侧 >30000 放弃本轮；缺失时脑侧用 2s/10s。

fixtures 已给 `send-response.expect` 增加 `status`/`headers`，并新增 `response-partial-onebot-error`、`response-all-failed-rate-limited`；`response-partial` 现在固定为 `429 + X-Retry-After-Ms`。

## M2 · 重试子集与 `replyToMessageId`

- 仅 HTTP 429 且 `failed[0].reason=rate_limited` 可重试；重试子集是从 `failed[0].index` 到原请求末尾的全部 index（含 `not_attempted` 尾部），保持原序，最多 2 次。
- 首失败不是 `rate_limited`：即使后面有 `not_attempted` 也不重试。
- `replyToMessageId` 只作用于一次实际 `/send` 的第一条；重试子集首条原始 index >0 时清空，等于 0 时保留；整批未发送时保留。
- 重试子包局部 index 必须映射回原始 index；不引入 `sendId`。

## M3 · L0/Receipt 崩溃恢复

选择：**启动重建 + 运行时补建**。

- `200` 的可观察保证：L0 + Receipt 已持久化；重启后同一 `eventId` 要么已终态/processing，要么可作为 `received` 恢复入队；不是“已回复”。
- 启动顺序：加载 Receipt → `processing` 置 `aborted` → 扫描 L0 用户记录，为缺失 Receipt 的 `eventId` 补建 `received`（不重写 L0）→ 服务层按 L0 `isAtBot`/`groupWake` 分流 → 再监听 `/hook`。
- 运行期重复路径：Receipt 已存在 → 普通重复，200 零副作用；Receipt 缺失但 `appendResult=duplicate` → 用携带的既有 L0 判定：可恢复 QQ user 补建 Receipt 并返回 `new`，CLI/assistant 或水位前记录返回 `ignored`，查不到/无效或 `t` 无法解析则失败并映射 503；两者都无才新建 L0。
- 补建/写盘失败 → 503；启动恢复失败 → 启动失败，不带着不确定状态接收。
- `EventStore.append()` 的 `null` 二义性由新增 T1.6 解决：增加 `appendResult()` 三态（`inserted`/`duplicate`/`write_error`），保留 `append()` 作为 CLI 兼容包装；L0 增加可选 `isAtBot` 元数据供恢复分流。
- 恢复过滤：只处理 `src='qq' && role='user' && Date.parse(t) >= receiptsSince`；CLI L0 永不补建 QQ Receipt。
- 首次启用水位：`receiptsSince` 在首次启用扫描前持久化；无历史 Receipt 时取当前时间，已有 Receipt 但缺水位则启动失败，不猜测。水位跨重启不重置；更早的 QQ L0 仅作为记忆/去重事实，不回放。
- 终态 tombstone：`done/failed/aborted` 持久化 Receipt 记录保留；`prune` 只清内存缓存，不得删除持久化终态记录；重启先排除 terminal 事件，避免已处理消息再次唤醒。
- 恢复分流严格布尔：仅 `record.isAtBot === true` 视为群 mention；缺失、非布尔、`"yes"`、`1`、`null` 等按 `false`，群消息 `stored_only`；私聊不受该字段影响。
- 错误脱敏：`appendResult.write_error.message` 可能含底层绝对路径，禁止原样写入 HTTP、日志或 `failureReason`；只记录固定文案/错误码。
- 运行期 `duplicate` 边界：`appendResult.duplicate` 携带已有 L0；仅可恢复的 QQ user 记录补建 Receipt，CLI/assistant 或水位前记录返回 `ReserveResult.ignored`（200 零副作用），查不到/无效记录或 `t` 无法解析返回失败并映射 503。

## M4 · 6/60 限流

- 每机器人账号全局 6 条/分钟、60 条/小时，不按会话/群/`reason` 拆分。
- 每条实际 OneBot 发送尝试计 1 条额度；超时/结果未知也计数。
- 额度不足立即 429，不睡眠、不排队；`X-Retry-After-Ms` 为两个窗口恢复所需最大毫秒数。
- `messageIntervalMs` 只是条间节奏，不得用于绕过额度。
- 限流历史为内存，重启清零作为已知风险明示，不声称跨重启严格全量。

## 证据与待办

- `npm run contract:check`：25/25 fixtures 通过。
- `npm run typecheck`：零错误。
- `npm test`：18 文件 / 150 tests 全绿（T1.6b/T1.5a-r 已落地并通过独立复核；另有文档/夹具变更，无新实现回归）。
- 新增 T2 断言：CLI L0 不恢复、首次启用历史 QQ L0 不回放、终态 prune 后重启不唤醒。
- `docs/CONTRACT.md` 未修改；未 commit/push。
- duplicate 增量快核 PASS；待总负责一次性签署后放行 T2/T5/T4c。T1.5a/T1.5a-r/T1.6/T1.6b 均已完成并独立复核。
