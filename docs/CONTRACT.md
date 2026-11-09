# ds-memory ↔ qq-gateway 接口契约

> 当前版本：**v1.3（脑侧普通群成员 @ 回复与节流；线上 JSON 不变）**
> 历史版本：v1.1 已签署 2026-11-04；v1.2 权限收紧、v1.2.1 fixture schema 扩展为其直接前序基线
> 依据：`docs/DECISION-LOG.md`（G1–G8、裁决 A/B/C、回环端口冲突治理、G2 拆分、用户权限裁决）。
> 纪律：字段只增不删不改义；`tests/contract/*.json` + `manifest.sha256` 为唯一权威；
> 任何一侧发现歧义：先改本草案并重新裁决，再同步两仓 fixtures，最后才改实现。

## 0. 拓扑

> G2-b：正向 WS `ws://127.0.0.1:3001/` + Bearer token；HTTP `3000` 仅用于 `get_msg`/`get_status`；G2-c 降级规则保留。

```text
QQ ── SnowLuma(OneBot v11, 3000/3001) ── qq-gateway（独立进程，薄网关）
                                              │ 本机回环 HTTP（127.0.0.1）
                                              ▼
                                        ds-memory（脑：agent + 记忆 + 权限）
```

- 全程使用**字面量 `127.0.0.1`**，禁止 `localhost`（避免解析到 `::1`）；明文 HTTP，靠共享 token 鉴权（回环内不做 TLS）。
- G2-a：网关与 SnowLuma 同机，SnowLuma 监听回环；网关只连 `127.0.0.1`。同机非回环、异机均不在本期范围，属显式安全决策，须另行批准。
- G2-c：`get_msg` 不可用时 `quote=null`，`isAtBot` 仅由 `at` 段判定（引用机器人降级为不唤醒），不阻塞。
- 网关 = 哑传输层：协议、token 自愈、发信限流（QQ 风控），**不含任何 AI 逻辑、不含权限判断**。
- 脑 = 全部智能：会话映射、权限、合批、记忆、回复节奏。

## 1. 鉴权

- 除 `/health` 外，所有请求带 `X-Memory-Token: <共享token>`；缺失或不符 → `401`。
- `/health` 无需 token，但仅绑定回环，响应不得包含任何密钥/token。
- token 生成建议：`node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`。

## 2. 网关 → 脑：消息上报

`POST /hook/message`（脑侧 `qq.hookPort`，首选 `985`，实际端口见 §5）

```jsonc
{
  "v": 1,
  "eventId": "evt:10001:message:3589",        // v1.1 新增：必填、稳定、对脑侧不透明
  "at": 1750000000000,                         // 网关收消息时间（毫秒）
  "source": {
    "kind": "private",                         // "private" | "group"
    "id": "123456789",                         // QQ 号或群号（字符串，防大数精度）
    "groupName": null                          // 群聊时有值（可选）
  },
  "sender": { "qqId": "987654321", "nickname": "小鲸鱼他爹" },
  "messageId": "3589",                         // OneBot message_id（可选，仅用于引用回复）
  "text": "在吗",
  "isAtBot": false,                            // 群聊 @机器人 或引用机器人
  "quote": null,                               // { "text": "...", "fromName": "..." } | null
  "media": [],                                 // 预留：P2 首版一律空数组
  "poke": null                                 // 预留：{ "fromName": "..." } | null
}
```

### 2.1 eventId（G1）

- **必填** `eventId: string`；缺失或非字符串 → `400`。
- 由网关从源事件**确定性推导**，重试与重启后不得变化、不得重新生成：
  - 消息事件：`evt:<selfId>:<postType>:<messageId>`；
  - 无 `message_id` 的事件（notice/request）：`evt:<selfId>:<postType>:<time>:<userId>:<noticeType|requestType>`。
- 对脑侧为**不透明字符串**，仅用于去重；脑侧不解析、不重算。
- `messageId` 继续只用于引用回复，**不得代替 `eventId`**。

### 2.2 响应与失败语义

```jsonc
{ "ok": true }
```

- `200 {ok:true}` = **接收记录（完整原文 L0 + Receipt）已持久化，重启后不会静默丢失**：`received` 可恢复入队，`processing` 不补投，`done/failed/aborted` 为终态；不表示已经回复。
- 脑侧必须先完成去重、L0 与 Receipt 持久化，再返回成功；启动时先完成 Receipt 恢复，再监听 `/hook`。
- 重复 `eventId`（Receipt 已存在）：返回同样的 `200 {ok:true}`，写日志，**不重写 L0、不入队、不唤醒 Agent**。
- 仅 L0 存在而 Receipt 缺失（上次在两次写盘之间崩溃）：不属于已完成的重复事件；脑侧必须先补建 `received` Receipt 再返回 `200`，并允许恢复一次入队/唤醒。
- 无法补建 Receipt、L0 写失败或 Receipt 写失败：返回 `503`；不得用 `200` 掩盖未持久化状态。
- `400` 形状非法 / `401` token 错 / `413` 请求体超 64 KB：网关**不重试**，丢弃并记错误日志。
- `403` 脑侧因黑名单拒绝：网关**不重试**，丢弃并记**告警日志**；只终止当前事件，**不做会话级降频、不维护任何权限状态**（权限全在脑侧）。
- `503` 临时持久化失败（属 5xx）：网关在事件 TTL（5 分钟）内按 §2.3 退避重试；**TTL 不因重试重置**。
- 其他 5xx / 超时 / 网络错误：同 `503` 路径，在 TTL 内重试；超时丢弃并日志。

### 2.3 网关上报队列（G6）

- 内存队列容量 **10,000** 条；满载丢弃最旧并告警计数。
- 每事件 TTL **5 分钟**（自入队起算）。
- 网络错误/超时/5xx 按 `1s/2s/4s/…/上限 30s` 退避重试；过期丢弃并日志。
- `400/401/403/413` 不重试。
- 请求体上限 **64 KB**（`/hook/message` 与 `/send` 相同）；超限 `413`。

### 2.4 脑侧去重（G1 / 裁决 A）

- 去重默认 **10 分钟**（`qq.dedupeTtlMs=600000`），**下限 6 分钟**，不得再调低。
- 去重键 = `eventId`；脑侧以 L0 记录 `id` 承载，重启后从已持久化 L0 重建窗口。
- L0 保存完整原文；说话人、引用与 `isAtBot` 作为独立元数据保存，不拼进 `text`。
- 内存实现，不引入数据库；终态 Receipt 的易失条目可按 TTL 清理，L0 去重事实保留。
- **首次启用水位**：Receipt 首次启用时，必须在扫描 L0 前持久化 `receiptsSince`（毫秒）；没有历史 Receipt 时取当前时间。若已有 Receipt/日志但缺少该水位，启动失败并告警，不得猜测。`receiptsSince` 跨重启不得重置。
- **恢复过滤**：只有 `record.src === "qq"`、`record.role === "user"` 且 `Date.parse(record.t) >= receiptsSince` 的 L0 记录才可补建 Receipt。水位之前的 QQ L0 只作为记忆与去重事实，不补建、不回放、不唤醒；CLI L0 永不进入 QQ Receipt 恢复。
- **终态 tombstone**：`done/failed/aborted` 的持久化 Receipt 记录必须作为 tombstone 保留；`prune` 只能清理内存缓存，不得删除或压缩掉持久化终态记录（否则重启会把终态 L0 当 L0-only 再唤醒）。`bootstrapFromL0()` 必须先按持久化 terminal Receipt 排除终态事件。
- 启动恢复顺序固定：读取 Receipt 与 `receiptsSince` → 将遗留 `processing` 置为 `aborted` → 扫描满足上述过滤条件的 L0 用户记录，为缺失 Receipt 的 `eventId` 补建 `received` → 再将所有可恢复 `received` 交给服务层入队。补建只能写 Receipt，不能重写 L0。
- 运行时重复路径：Receipt 已存在 → `duplicate`，200 零副作用。Receipt 不存在但 `appendResult()` 返回 `duplicate` → 必须用其携带的既有 L0 判定来源：仅 `src==='qq'`、`role==='user'` 且 `Date.parse(t)>=receiptsSince` 的记录才补建 `received` 并返回 `new`（一次恢复，不是重复唤醒）；CLI/assistant 记录或早于 `receiptsSince` 的 QQ L0 → 200 零副作用（不补建、不入队、不唤醒）；查不到或记录无效 → 503，不得 ACK 不确定状态。L0 与 Receipt 都不存在时才新建 L0 并写 `received`。
- 为消除“再读 L0”的竞态，内部接口必须显式携带既有记录与 `ignored` 结果，不能只靠文字约定：

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

- duplicate 返回的 record 必须存在且字段有效；`t` 无法解析同样按记录无效处理，返回 503，不得当作普通重复。

## 3. 脑 → 网关：发送

`POST /send`（网关端口，首选 `803`，实际端口见 §5）

```jsonc
{
  "v": 1,
  "target": { "kind": "private", "id": "123456789" },
  "messages": ["第一条", "第二条", "第三条"],   // 按序发送；网关控制条间间隔（防刷屏）
  "replyToMessageId": null,                     // 引用回复（可选）
  "reason": "reply"                             // "reply" | "proactive" | "admin"（仅网关日志用）
}
```

### 3.1 响应形状（G4）

全成功：

```jsonc
{ "ok": true, "sent": [ { "messageId": "7001" }, { "messageId": "7002" } ] }
```

部分失败（HTTP 状态按 §3.3；下面示例是 429）：

```jsonc
{
  "ok": false,
  "sent": [ { "messageId": "7001" } ],
  "failed": [
    { "index": 1, "reason": "rate_limited" },
    { "index": 2, "reason": "not_attempted" }
  ]
}
```

- 网关按序发送，**首条失败即停**；`sent` 为成功前缀。
- `failed.index` **0 起始**；`failed` 包含首个失败项 + 其后全部未尝试项（未尝试项 reason 为 `not_attempted`）。
- `failed` reason 枚举：`rate_limited`、`onebot_error`、`timeout`、`network_error`、`http_5xx`、`not_attempted`。
- 不变量：`sent.length + failed.length` **必须等于**本次请求 `messages.length`（`failed` 缺省视为 `[]`）；`failed` 非空时 `failed[0].index` 必须等于 `sent.length`。
- 脑侧以「请求 index 集合 − failed index」推导 `sentIndexes`，**不依赖 `sent` 数组顺序**；index 越界/重复/遗漏/数量不符一律视为非法响应，按歧义失败放弃。

### 3.2 重试与放弃（G4 / 裁决 A）

- 仅 HTTP `429` 且 `failed[0].reason === "rate_limited"` 可重试。
- 重试子集 = 从 `failed[0].index` 到本次原始请求末尾的全部 index，按原序重新组包；其中 `not_attempted` 尾部随 429 一起重试，**不得只重试首个失败项而静默截断尾部**。
- 首失败不是 `rate_limited`（含 `timeout`、`onebot_error`、`network_error`、`http_5xx`）时一律不重试，即使后面存在 `not_attempted`。
- 重试最多 **2 次**；子包局部 index 必须映射回原始 index。
- `replyToMessageId` 只作用于一次 `/send` 实际尝试的第一条。重试子集若首条原始 index > 0，必须清空该字段；若首条原始 index 为 0，可保留。整批从未发送（`failed[0].index === 0`）时保留。
- 间隔优先 `X-Retry-After-Ms`：值为非负整数毫秒，表示网关建议的实际等待；**网关不得把 >30s 的值截成 30s**，脑侧见 **>30000 放弃本轮**；响应头缺失时用 `2s/10s`。
- `429` 响应体缺少合法 `sent/failed` 或 `failed[0]` 非 `rate_limited` → 非法响应，按歧义失败放弃。
- `200` 响应中首失败为 `rate_limited` → 同样视为非法响应，不重试。
- 超时 / 网络错误 / 其他 5xx / 非法响应体：**一律放弃本轮，不重发**（发送结果未知，避免歧义重发）。
- 网关不替脑缓存消息、不自动重发；**不引入 `sendId`**。

### 3.3 `/send` 状态矩阵（G6）

| 场景 | HTTP | 响应体 | 头 | 脑侧动作 |
| --- | --- | --- | --- | --- |
| 全部成功 | `200` | `{ok:true,sent}` | 无 | 记录 `sent`；`all_sent` |
| 非 429 的应用级部分/全部失败（`onebot_error`/`timeout`/`network_error`/`http_5xx`） | `200` | `{ok:false,sent,failed}` | 无 | 保留 `sent` 前缀；`partial` 或 `none_sent`；不重试 |
| 首失败为 `rate_limited`（可含成功前缀） | `429` | `{ok:false,sent,failed}`，`failed[0]=rate_limited` | `X-Retry-After-Ms`（建议必带） | 按 §3.2 重试尾部；`retryable=true` |
| 形状非法 / 空 `messages` | `400` | `{ok:false}` | 无 | `none_sent`；放弃 |
| token 错 | `401` | `{ok:false}` | 无 | `none_sent`；放弃 |
| 请求体 >64 KB | `413` | `{ok:false}` | 无 | `none_sent`；放弃 |
| 网关内部错误，未产生可靠发送结果 | `500`/`503` | `{ok:false}` | 无 | `ambiguous_failure`；放弃，不重发 |
| 非法响应体 | 任意 | 非法 | 任意 | `ambiguous_failure`；不重发 |

> 单条 OneBot 失败属于**应用级结果**，必须返回 `200` 让脑侧拿到 `sent` 前缀；只有网关自身无法给出可靠发送结果时才使用 5xx。`429` 是唯一保留非 2xx 的应用级结果。

### 3.4 网关发送限流（G6 / v1 既有 6/60）

- 每个机器人账号全局共享 **6 条/分钟、60 条/小时**；不按群/私聊拆分，不按 `reason` 绕过。
- 每条**实际 OneBot 发送尝试**占用 1 条额度；超时或结果未知也占用，按保守风控处理。
- 额度不足直接返回 `429`，不睡眠等待、不排队；当前条及之后未尝试项按 §3.1 的 `rate_limited`/`not_attempted` 返回。
- `X-Retry-After-Ms` = 两个窗口都恢复可发送所需的最大毫秒数，非负整数；>30000 由脑侧放弃本轮。
- `messageIntervalMs` 是条间发送节奏，不是额度等待；不得用睡眠绕过限额。
- 限流历史为进程内内存；重启后清零是**已知风险**，文档与验收不得声称跨重启严格全量。

## 4. 健康与握手

- 脑：`GET /health` → `{ "name": "ds-memory", "version": "0.2.0", "ok": true, "hookPort": <实际绑定端口> }`
- 网关：`GET /health` → `{ "name": "qq-gateway", "version": "0.1.0", "ok": true, "online": true, "selfQqId": "..." }`
  - `ok:true` 表进程健康；`online` 表 OneBot 连接状态。
  - `selfQqId` 从未连接过为 `null`；首次连接成功后保留最后已知值，断线**不清空**。
- 双侧 `/health` **无需 token**；仅绑定回环；响应不含密钥。
- 双方启动后各探测对方 `/health`；连不上只告警不退出（网关断线自愈，脑等待上报）。

## 5. 服务发现（v1.1 新增）

### 5.1 首选端口 + 自动回退

- 脑侧 `qq.hookPort` 首选 **985**；网关 `server.port` 首选 **803**。
- 绑定失败（`EADDRINUSE` / `EACCES`，含 Windows 保留端口段）→ 改绑 `0` 由系统分配，记 warn 日志（含错误码），继续启动。
- 两者均 <1024；Windows 无特权端口限制。若未来迁至 Unix，需改用高段端口或授予绑定能力，届时另行裁决。

### 5.2 端点文件

监听成功后**原子写**（临时文件 + rename）到共享 `runtimeDir`：

```jsonc
{
  "v": 1,
  "name": "ds-memory",          // "ds-memory" | "qq-gateway"
  "host": "127.0.0.1",
  "port": 985,
  "pid": 12345,
  "startedAt": 1750000000000,
  "instanceId": "uuid"
}
```

- 文件名：`ds-memory.endpoint.json` / `qq-gateway.endpoint.json`。
- **禁止写入 token**；仅含地址元数据。
- 正常关闭且 `instanceId` 匹配时删除本实例端点文件。
- `runtimeDir` 默认：Windows `%LOCALAPPDATA%\DSH\runtime`；其他平台 `$XDG_RUNTIME_DIR/dsh`，缺失时 `~/.dsh/runtime`。两仓均可配置覆盖，默认规则必须一致。

### 5.3 发现顺序与校验

1. **显式 URL 覆盖优先**：脑侧 `qq.gatewayUrl`；网关 `brain.hookUrl` / `brain.healthUrl`。空串 = 发现模式。
2. 否则读对端端点文件，校验：`v===1`、`name` 匹配、`host` 为回环字面量、`port` 在 1..65535、`pid` 存活。
3. 连接失败或文件变化时重读；文件缺失或 pid 已死按对端离线处理，沿用既有重试/健康策略。
4. 客户端必须使用字面量 `127.0.0.1`；端点文件中的 `host` 按字面量使用。

### 5.4 单实例

- 启动前先读端点文件；`pid` 存活则**拒绝启动第二实例**；仅 stale 文件允许清理/覆盖。
- 关闭时只删除属于本 `instanceId` 的端点文件，避免误删其他实例。

### 5.5 不做

- 不采用命名管道 / UDS（`fetch`/undici 支持成本高、平台差异大）。
- 不采用「固定端口失败即退出」（不解决用户场景）。
- 绑定非回环地址属显式安全决策，须另行批准。

## 6. 会话与权限（全部在脑侧）

- 会话 key：私聊 `private:<qqId>`；群 `group:<id>`。
- 判定顺序：黑名单 > owner（`private:<ownerQQ>` 全权限）> 白名单群（聊天档）> 其他（不响应）。
- 网关**不得**对消息做任何内容过滤/权限判断（契约只传原始件）。
- 群唤醒默认 `groupWake="mention"`（@或引用机器人才唤醒；其余群消息只保存 `stored_only`），枚举 `"mention" | "all"`。
- v1.3：白名单群放行的仍是「持久化到 L0」；模型准入为 owner，或开启 `groupMemberReply` 后的普通成员 `@`/引用（`mention`）消息。普通成员回复按群节流，owner 豁免。陌生私聊维持静默 ignore。详见 §10。

## 7. 契约测试与 fixtures

- 唯一权威：`ds-memory/tests/contract/*.json` + `ds-memory/tests/contract/manifest.sha256`。
- qq-gateway 持有一份副本 + 同一清单；两仓 `npm run contract:check` 校验本地文件与清单哈希一致，作为 CI/验收门。
- fixtures 只约束**线上 JSON 形状与 HTTP 结果**（如 `200 {ok:true}`），不承载权限/唤醒/节流断言；是否唤醒由脑侧 `ownerQQ`、`groupMemberReply`、`groupWake` 与 sender 权限共同决定，由 `ds-memory` 单元/集成测试覆盖。
- fixture 统一包装：

```jsonc
{
  "name": "hook-message-private-valid",
  "kind": "hook-request",          // "hook-request" | "send-request" | "send-response" | "endpoint" | "mapping-pair"
  "description": "...",
  "payload": { /* 原始 JSON */ },
  "expect": { /* kind 相关期望，见下 */ }
}
```

- `hook-request.expect`：`{ "status": 200 | 400 | 401 | 403 | 413 | 503, "body"?: { "ok": boolean } }`。
- `send-request.expect`：`{ "requestCount": number, "status"?: 200 | 400 | 401 | 413 }`。
- `send-response.expect`：`{ "status": 200 | 400 | 401 | 413 | 429 | 500 | 503, "headers": Record<string,string>, "requestCount": number, "outcome": "all_sent" | "partial" | "none_sent" | "ambiguous_failure", "sentIndexes": number[], "failedIndexes": number[], "retryable": boolean, "retryIndexes"?: number[], "retryAfterMs"?: number | null, "retryReplyToMessageId"?: string | null, "reason"?: string | null }`。
- `endpoint.expect`：`{ "valid": true | false, "reason"?: string }`。
- `mapping-pair.expect`：`{ "ok": boolean, "hook": <完整 hook JSON> }`（用于 OneBot 原始事件 → /hook 的映射成对断言）。
- 覆盖类别：合法 private/group、@/引用、非法形状、超大文本、缺失字段、错误类型、部分发送、429、非法 index/数量、端点文件合法/缺字段/错类型/非回环/端口越界/pid 已死。
- 本版清单共 26 个 fixture：hook 8（private/group mention/group plain/负 messageId/缺 eventId/缺字段/错类型/超大文本）、send 10（合法请求/空 messages/全成功/部分 429/部分非 429/全失败 429/越界 index/数量不符/重复 index/缺 failed）、endpoint 7（两组合法/缺字段/错类型/非回环/端口越界/pid 已死）、mapping 1（card-first + reply/get_msg 成对映射）。
- 变更流程固定：改契约提案 → 另一侧评审 → 总负责裁决 → 更新权威 fixtures + 清单 → 两仓同步 → 改实现。禁止绕过清单直接改副本。

## 8. 版本演进

- v0：文本私聊/群聊、@与引用、发送、健康检查。
- v1：现有上报/发送/健康形状（无 `eventId`）；明确不做图片/语音/合并转发/拍一拍动作。
- v1.1：新增必填 `eventId`、`200=已持久化且可恢复`、`503` 临时失败、64 KB 限制、failed/index 不变量、429 重试纪律、服务发现与端点文件；删除 403 的会话级降频表述；不引入 `sendId`。
- v1.2：脑侧权限收紧——群聊仅 `sender.qqId === ownerQQ` 的消息可进入模型；非管理员群消息 `stored_only`；L0 新增内部元数据 `senderQqId`/`modelEligible`；旧群聊缺 `modelEligible` fail-closed。线上 JSON 形状不变，网关零改动。
- v1.2.1：fixture schema 扩展 `mapping-pair` 与第 26 个映射成对 fixture；P2 文档校准；无线上字段变化。
- v1.3：脑侧权限调整为 owner + 普通成员 `@`/引用可回复；新增 `qq.groupMemberReply` 节流（默认同群 3 秒、每分钟 6 条；member 每回合一条；owner 豁免）。L0 旧群聊缺 `modelEligible` 仍 fail-closed。线上 JSON 形状不变，网关零改动。
- **线上 `v` 仍为 `1`**；`v1.1` 只是文档/契约版本号，不得把线上字段发送成 `1.1`。

## 9. 与 v1 的差异摘要

1. 上报新增必填 `eventId`（稳定、不透明、缺失 400）；`messageId` 仅用于引用。
2. `200` 语义改为「接收记录已持久化且重启后可恢复」；重复事件同响应、不重复处理；新增 `503`，并明确 L0-only 崩溃恢复。
3. 403 只终止当前事件，网关不做会话级降频/权限状态。
4. `/send` 明确 `sent` 成功前缀、`failed` 首个失败 + 全部 `not_attempted`、index 0 起始、数量不变量；部分失败 HTTP 状态按 §3.3 与响应体绑定。
5. 429 仅重试 `failed[0]` 至末尾的尾部，优先 `X-Retry-After-Ms`（>30s 放弃）、缺失 2s/10s、最多 2 次；重试子集首条原始 index >0 时清空 `replyToMessageId`；其他失败一律放弃。
6. `/health` 无需 token；`selfQqId` 断线保留最后已知值。
7. 新增 64 KB 请求体上限与 `413`；上报队列容量 10,000、TTL 5 分钟。
8. 新增服务发现：首选端口 985/803、绑定失败回退 0、端点文件 + `runtimeDir`、单实例语义。
9. fixtures 增加 `manifest.sha256` 与包装 schema；两仓 `contract:check`。
10. 冻结不引入 `sendId`。
11. 网关 6/60 限流口径、实际发送尝试计数、429 直接返回与重启清零风险写入契约。
12. 脑侧启动从 L0 重建缺失 Receipt；`EventStore` 写失败与重复 id 必须可区分。

## 10. v1.2/v1.3 修订：群聊 sender 权限与成员节流（脑侧，不改线上 JSON 形状）

> 本节只调整脑侧「谁的消息可以进入模型」与「成员回复节奏」，**不改变线上字段**：
> `/hook/message` 的 `source`、`sender.qqId`、`isAtBot` 等字段形状与 v1.1 完全一致；
> 网关仍是哑传输层，不做权限判断。本修订不新增、不删除线上字段。

### 10.1 规则

1. **私聊**：只有 `ownerQQ` 私聊可进入模型；陌生人私聊**仍返回 `200 {ok:true}`**，脑侧静默 ignore（不落 L0、不产生 Receipt、不建会话、不响应），不是 403。
2. **群聊持久化**：白名单群内所有消息都可以持久化到 L0（`200 {ok:true}`，原文完整保留）。
3. **群聊模型准入**：`sender.qqId === ownerQQ` 始终可进入 inbox/wake（仍受 `groupWake` 约束）。开启 `qq.groupMemberReply.enabled` 后，普通成员在 `mention` 下仅 `isAtBot === true` 时进入；`groupWake="all"` 时普通成员未 @ 消息也可进入。关闭开关时恢复 v1.2 owner-only。
4. **普通成员非唤醒消息**：响应 `200`；Receipt 终态 `done(outcome=stored_only)`；不调用 provider、不生成 assistant、不发送。
5. **管理员群消息**：仍受 `groupWake` 约束。`mention` 下需 `isAtBot === true`，否则 `stored_only`；`all` 下管理员消息全部唤醒。owner 回复不受成员节流限制。
6. **普通成员回复节流**：`mention`/`all` 唤醒的 member 回合，按群会话执行 `minIntervalMs`（默认 3000）与 `maxPerMinute`（默认 6）；每回合只发一条完整回复。超出上限的消息只持久化，不调用 provider。
7. **命令权限**：`!记`/`!note`/`!回忆` 仍只接受单条 owner 批次；普通成员发同样文本按普通聊天处理。

### 10.2 L0 元数据与恢复语义

- L0 新增独立元数据字段（**只增不改义，旧记录可缺省**）：
  - `senderQqId?: string`：消息发送者 QQ。
  - `modelEligible?: boolean`：该条消息是否允许进入模型/检索上下文。
- `senderQqId` 与 `modelEligible` 是 **ds-memory 内部 L0 / RawRecord 元数据**，**不进 `/hook`、`/send` 线上字段**；`senderQqId` 由既有 `sender.qqId` 派生，网关零改动。
- 新记录：私聊 / 管理员群消息 `modelEligible=true`；普通成员 `@`/引用消息（或 `groupWake="all"` 下的成员消息）为 `true`；普通成员非唤醒消息为 `false`。
- 旧记录 fail-closed：
  - 旧群聊 user L0 缺 `modelEligible` → 不唤醒、不进入检索。
  - 旧私聊 `src=qq` 且 `sessionKey=private:<ownerQQ>` 可视为 eligible；其他缺字段私聊 fail-closed（不唤醒、不检索）。
  - CLI 记录维持原行为。
- 重启恢复按同一规则重新判定：owner 或符合条件的成员消息才恢复入队，其余标记 `stored_only`；旧群聊缺 `modelEligible` 一律 fail-closed。
- `text` 始终是 L0 完整原文，不把昵称/引用拼进 `text`。

### 10.3 对 §6 的增量

§6 的会话 key、黑名单 > owner > 白名单群 > 其他、网关不做权限判断、`groupWake` 枚举均继续有效。v1.3 在白名单群持久化之上增加：owner 全放行；普通成员按 `groupMemberReply` + `isAtBot`/`groupWake` 放行，并接受成员节流。

### 10.4 fixtures 与清单

线上 JSON 形状未变；v1.3 仅更新脑侧权限/节流语义与 `message-group-mention-valid.json` 的中性说明，`manifest.sha256` 重算后两仓同步。qq-gateway 代码零改动，`contract:check` 仍为 26/26。
