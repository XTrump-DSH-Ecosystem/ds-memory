# 决策日志

> 本文件记录总负责（用户 + 首席工程师）的书面裁决，是会话之外的权威记录。
> 权威顺序：本日志与总负责最新书面决定 > `docs/CONTRACT.md` > 已批准架构 > 历史简报。
> 未写入本文件的“建议/回执/评审意见”均不构成已冻结需求。

## 2026-11-03 · G1–G8 门禁裁决（qq-gateway P0）

背景：qq-gateway 仓库当前仅有 docs（`CONTRACT.md`、`ARCHITECTURE.md`、`docs/tasks/P0-TASK-PACKAGE.md`），无代码、无 commit。G1–G8 为实施门禁，G8 实施授权由总负责接管，交接不自动解除。

### G1 · eventId 与脑侧幂等 — 已裁决

- `/hook/message` 载荷新增必填字段 `eventId: string`。
- 由源事件确定性推导，重试与重启后均不得变化、不得重新生成：
  - 消息事件：`evt:<selfId>:<postType>:<messageId>`；
  - 无 `message_id` 的事件（notice/request）：`evt:<selfId>:<postType>:<time>:<userId>:<noticeType|requestType>`。
- 脑侧先按 eventId 去重并完成 L0 必要持久化，再返回 `{ok:true}`；重复 eventId 返回同样的 `{ok:true}`、写日志、不唤醒 Agent。
- 去重窗口 ≥ 6 分钟（覆盖网关 5 分钟 TTL + 时钟偏差）；内存实现，不引入数据库；脑侧重启后须能从已持久化 L0 重建窗口，机制由 ds-memory 架构师定。
- eventId 对脑侧为不透明字符串，仅用于去重。

### G2 · OneBot 部署事实 — 待用户事实，暂缓

裁决未作出。需要用户提供：部署机与监听地址（是否回环）、连接方向（SnowLuma 作 WS 服务端 / HTTP 回调 / 反向 WS）、`get_msg` 可用性、心跳方式。T03 及以后依赖本项；T02 不依赖。

### G3 · 403 语义 — 已裁决

- 403 只终止当前事件：丢弃、不重试、告警日志。
- 网关不做会话级降频，不维护任何权限状态（权限全在脑侧）。
- 修订 CONTRACT：删除“网关此后对该会话静默降频”的表述。

### G4 · 部分发送 — 已裁决

- 网关按序发送，首条失败即停；响应 `ok:false`：`sent` = 成功前缀，`failed` = 首个失败 index + 其后全部未尝试项。
- `failed` 中未尝试项的 reason 为 `not_attempted`；失败 reason 枚举：`rate_limited`、`onebot_error`、`timeout`、`network_error`、`http_5xx`。
- 仅 `rate_limited`（429）可重试：脑侧只对未成功 index 重新组包（保持原序），最多 2 次；间隔优先 `X-Retry-After-Ms`（上限 30s，超限视为放弃本轮），缺失时 2s/10s；仍失败 → 日志放弃本轮。
- 超时 / 网络错误 / 其他 5xx / 其余失败：脑侧一律放弃本轮、不重发（发送结果未知，避免歧义重发）。
- 网关不替脑缓存、不自动重发；sendId 继续冻结。

### G5 · 健康与鉴权 — 已裁决

- 双侧 `/health` 无需 token：仅绑定 127.0.0.1，响应不含密钥。
- 网关 `/health`：进程存活即 200；`ok:true` 表进程健康，`online` 表 OneBot 连接；`selfQqId` 从未连接过为 `null`，首次连接成功后保留最后已知值，断线不清空。
- 脑侧 `/health` 维持现状（name/version/ok/hookPort）。

### G6 · 队列与状态矩阵 — 已裁决

- 上报队列：内存、容量 10,000 条；满载丢弃最旧并告警计数。
- 每事件 TTL 5 分钟（自入队起算）；网络错误/超时/5xx 按 1s/2s/4s/…/上限 30s 退避重试，过期丢弃并日志。
- 400/401/403 不重试：400 形状错误 → 丢弃 + 错误日志；401 token 错 → 丢弃 + 错误日志（配置事故）；403 按 G3。
- 请求体上限：`/hook/message` 与 `/send` 均 64 KB，超限 413。
- `/send` 状态矩阵：200 按 G4；400/401 → 脑侧放弃本轮 + 错误日志；429 → G4；413 → 放弃 + 日志；超时/网络/其他 5xx → 放弃本轮。

### G7 · fixture 唯一源 — 已裁决

- 唯一权威：`ds-memory/tests/contract/*.json` + 清单 `ds-memory/tests/contract/manifest.sha256`。
- qq-gateway 持有一份副本 + 同一清单；两仓 `npm run contract:check` 校验本地文件与清单哈希一致，作为 CI/验收门。
- 变更流程固定：改契约提案 → 另一侧评审 → 总负责裁决 → 更新权威 fixtures + 清单 → 两仓同步 → 改实现。禁止绕过清单直接改副本。

### G8 · 实施授权 — 未解除，条件明确

- 仅 T02 的解除条件：(a) 本决策记录落盘；(b) T00/T01 补件验收通过，其中 T00 须含小任务分解、负责人、完整测试映射，T01 须含 OneBot 原始事件 → hook JSON 成对样例及逐字段合法/缺失/错误类型/边界样例，且与 G1/G3/G4/G6/G7 裁决一致；(c) “文档行数与磁盘实测不一致”以实测核实。
- T03–T07 继续冻结；T03 额外依赖 G2 事实；T04/T05 额外依赖契约 v1.1 同步。
- 不一次性释放全部实施包。

### 契约 v1.1 同步指令

G2 事实补齐后：ds-memory 侧按本裁决更新 `CONTRACT.md` v1.1 与 fixtures + 清单；qq-gateway 侧核对副本并运行 `contract:check`；总负责签署后生效。T02 不依赖契约 v1.1，可先行。

## 2026-11-03 · ds-memory P2 两项裁决与验收重试规则

### 裁决 A · CONTRACT 修订提案会签 — 同意（附合并条件）

- 同意 `docs/P2-TASK-BREAKDOWN.md` §9 十条提案作为 CONTRACT v1.1 基稿，并按 G1/G3/G4/G5/G6/G7 裁决合并以下细节：
  1. `eventId` 必传、重试稳定、缺失 400；`messageId` 仅用于引用，不得代替 `eventId`。
  2. `200 {ok:true}` = 接收记录已持久化；重复事件同响应、不重复处理；临时持久化失败 503（属 5xx，网关在 TTL 内退避重试，TTL 不重置）；400/401/403 不重试。
  3. 脑侧去重默认 10 分钟（`dedupeTtlMs=600000`），下限 6 分钟，不得再调低。
  4. `failed.index` 0 起始；`sent` 为成功前缀，`failed` 含首个失败项及全部未尝试项（`not_attempted`）；`sent.length + failed.length` 必须等于请求条数。
  5. 429 只重试 failed 中未成功 index、最多 2 次；优先 `X-Retry-After-Ms`，但其值 >30s 视为放弃本轮；缺失用 2s/10s；超时/网络/5xx/非法响应一律放弃本轮；不引 `sendId`。
  6. 两侧先同步 CONTRACT + fixtures 再改实现；不做「脑侧临时生成 eventId」的兼容 fallback。
- v1.1 不含 G2 依赖项：拓扑行维持 v1 原文，G2 裁决后再另行修订。
- 签署顺序：ds-memory 按本裁决产出 v1.1 草案 + 权威 fixtures + `manifest.sha256` → qq-gateway 侧核对草案与决策日志一致 → 总负责签署 → T2/T5 闸门解除。

### 裁决 B · 小群唤醒策略 — 默认「仅 @/引用唤醒」

- `qq.groupWake` 默认值 `"mention"`：@机器人或引用机器人 → 唤醒；其余群消息仅保存，`outcome=stored_only`。
- 枚举 `"mention" | "all"`；`"all"` 保留为可切换配置值，不删除。
- 理由：全部群消息仍完整入 L0（记忆不损失）；避免每条群消息触发模型调用和不必要的群回复（额度与 QQ 风控）；低风险可逆，翻转配置即可验证。
- 群唤醒实现（T3c 群部分、T4 群回合）在 Receipt/WakePacket 接口冻结后开工。

### 裁决 C · 验收脚本重试 — 仅限已记录的 Windows tinypool teardown 抖动

- 全量测试允许一次自动重跑，条件：失败签名仅为 `Unhandled Rejection: Channel closed`（tinypool teardown）；重跑证据必须写入验收报告；集成测试首跑必须绿；其他失败模式不得自动重跑、如实上报。
- 禁止通过删除测试或降低阈值凑绿。

### 放行与不放行（本轮）

- 放行：T1a/T1b/T1c。T1a 可含 `qq.groupWake` 默认 `"mention"`（裁决 B 已解除该限制）；T1b 仍不定义 `HookEvent`/`QqTarget`/`SendResult` 线上形状；边界照 §5-T1 执行。
- 架构师须先评审冻结 `Receipt`/`WakePacket`/`ReplyPlan`/`SendResult` 四接口并报总负责签署，之后才放 T3（含普通私离合批）与 T4/T5 相关工作。
- 不放行：T2/T5（等 v1.1 签署与 fixtures 同步）、任何对权威 `docs/CONTRACT.md` 的改动（只允许产出草案）、commit。

## 2026-11-03 · 授权与升级边界（常设，替代逐项请示）

### 原则

- 可逆、项目内、不触契约的决策：各层自行决定并记录，不升级。
- 仅五类事项升级到总负责：跨仓契约语义变更；超出预算的新运行期依赖或核心栈变更；公开 API/CLI/配置的破坏性变更；不可逆的数据、安全、凭据、EULA 事项；阶段门禁/T 包放行与范围扩张。
- 汇报按里程碑一次说清（已决定、证据、阻塞、下一动作），不按问题逐条请示。
- 决策日志、契约、基线已有答案的，直接引用执行，不再询问。
- 可逆内部事项：升级后一个工作日内无回复，按文档默认值执行并记录；不可逆、安全、契约类不适用。
- 总负责验收改为抽样 + 证据检查，不再逐行复审文档或实现；项目内质量由架构师负全责。

### 各层决策权

- 架构师：模块内设计、项目内接口形状、测试策略、任务包内容与验收、排期、返工；可自行冻结并记录 `Receipt`/`WakePacket`/`ReplyPlan`/`SendResult`，无需总负责逐接口签署；文档类产出（T00/T01）由架构师 + Tester 按标准自查验收并报结论。
- 组长：任务拆分、分派、依赖排期、一线验收与返工；常规执行问题不升级。
- Worker/Tester：任务卡内实现方案与测试设计自主；仅按 stop conditions 停止。

### 本轮即时放行

- ds-memory：T1a/T1b/T1c 立即下发（T1a 含 `qq.groupWake="mention"`）。四接口由架构师自行冻结并记录后，直接下发 T3 私聊合批与 T4a/T4b；T4c/T5 在 v1.1 签署后由架构师直接排期。
- ds-memory：CONTRACT v1.1 草案 + 权威 fixtures + `manifest.sha256` 由架构师直接落盘（内容以本日志裁决为准，不得改写语义）；qq-gateway 核对后报总负责一次性签署，不再逐条复审。
- qq-gateway：T02 即时放行（脚手架、配置、日志、测试基座），边界：不得定义契约派生线上类型、不得改权威 CONTRACT。T00/T01 补件并行推进，由 qq-gateway 架构师 + Tester 按本日志标准验收并报结论，无需总负责预审。T03 仍等 G2 事实；T04–T07 等 v1.1 与相应门禁。
- 以上放行不改变不可逆操作与 commit 仍需明确授权。

## 2026-11-03 · 回环端口冲突治理（并入 CONTRACT v1.1）

### 问题定性

- `127.0.0.1` 是回环地址，不会被“占用”；冲突源是端口（固定 4100/4200 可能被他进程占用，Windows 还可能落入 Hyper-V 保留端口段导致 EACCES）。绑定回环与令牌鉴权的安全边界不变。

### 裁决：首选端口 + 自动回退临时端口 + 共享端点文件发现

- 端口语义：脑侧 `qq.hookPort` 默认 4100、网关 `server.port` 默认 4200，均为**首选值**；绑定失败（`EADDRINUSE`/`EACCES`，含 Windows 保留端口段）→ 改绑 `0` 由系统分配，记 warn 日志（含错误码），继续启动。
- 端点发布：监听成功后原子写（临时文件 + rename）到共享 `runtimeDir`：
  `{ "v": 1, "name": "ds-memory" | "qq-gateway", "host", "port", "pid", "startedAt", "instanceId" }`
  文件名 `ds-memory.endpoint.json` / `qq-gateway.endpoint.json`；**禁止写入 token**；正常关闭且 `instanceId` 匹配时删除。
- `runtimeDir` 默认：Windows `%LOCALAPPDATA%\DSH\runtime`；其他平台 `$XDG_RUNTIME_DIR/dsh`，缺失时 `~/.dsh/runtime`；两仓均可配置覆盖，默认规则必须一致。
- 端点发现：显式 URL 覆盖优先（脑侧 `qq.gatewayUrl`、网关 `brain.hookUrl/healthUrl`，空 = 发现模式）；否则读对端端点文件，校验 `v`/`name`/回环 host/端口范围/`pid` 存活后使用；连接失败或文件变化时重读；文件缺失或 pid 已死按对端离线处理，沿用既有重试/健康策略。
- 单实例：启动前先读端点文件，`pid` 存活则拒绝启动第二实例；stale 文件才允许清理/覆盖。
- 安全：端点文件仅含地址元数据，鉴权仍靠 `X-Memory-Token`；绑定默认回环，改非回环属于显式安全决策，需另行批准。
- 客户端必须使用字面量 `127.0.0.1`，不得写 `localhost`（避免解析到 `::1` 导致 IPv6/IPv4 不一致）；端点文件中的 host 按字面量使用。
- 不采用命名管道/UDS：`fetch`/undici 支持成本高、平台差异大；不采用“固定端口失败即退出”：不解决用户场景。

### 影响与落位

- CONTRACT v1.1 新增「服务发现」节（端点文件形状、`runtimeDir` 默认规则、发现顺序）。
- ds-memory：T1a 增 `runtimeDir` 与端口语义；端点发布进 T2、发现进 T5/T6（均在 v1.1 签署后，不新增门禁）。
- qq-gateway：T02 增 `runtimeDir` 与首选端口语义；端点模块属契约派生实现，v1.1 签署后进 T02 后续或 T05/T06。
- fixtures 增加：合法/缺失/错误类型/pid 已死的端点文件样例，及发现解析用例。

### 附：首选端口值调整（同日前条为准）

- 用户指定特殊端口：**ds-memory hook 首选 `985`，qq-gateway 首选 `803`**（`0803` 按十进制 803）。
- 理由：数字好记、非通用开发端口，默认冲突概率低于 4100/4200；自动回退与端点发现机制不变，端口被占仍可启动。
- 说明：两者 <1024，Windows 无特权端口限制；若未来迁至 Unix 需改用高段端口或授予绑定能力，届时另行裁决。
- CONTRACT v1.1 默认值以本条为准；v1 的 4100/4200 仅作历史记录。

## 2026-11-03 · G2 拆分裁决：可定的定，不可定的转探针

### G2-a 部署机与监听 — 裁决：同机回环

- 网关与 SnowLuma 同机，SnowLuma 监听回环；网关只连 `127.0.0.1` 字面量，不用 `localhost`。
- 同机非回环、异机均不在本期范围；如未来需要，属显式安全决策，须总负责批准。

### G2-b 连接方向 — 转探针（T03-P），本轮不拍板

- 定性：这是部署事实，不是架构取舍；无事实拍板会把错误假设固化。
- 探针任务（只读，不启动/停止 SnowLuma，不发送 QQ 消息）：
  1. 带 token 请求 `http://127.0.0.1:3000/get_status`、`/get_login_info`、`/get_version_info`；
  2. 尝试 `ws://127.0.0.1:3001` 正向 WS 握手，记录是否收到 `meta_event.lifecycle` / `heartbeat`；
  3. 检查 SnowLuma 是否提供 HTTP 事件回调或反向 WS 配置；
  4. 用最近事件的 `message_id` 试 `get_msg`。
- 结果写入 `qq-gateway/docs/tasks/G2-PROBE-RESULT.md`，由 qq-gateway 架构师 + Tester 验收后报总负责。
- 实现假设（非契约）：默认按正向 WS + Node 内置 WebSocket（零新依赖）设计适配器；反向 WS 需 `ws` 依赖，仅当探针证明必须时另行裁决。
- 放行：T03 可先做适配器接口、假传输、重连与 online 状态机；T04 核心映射（含 eventId）可按标准 OneBot v11 事件形状先做，quote 走降级分支。真实传输与环境联调等探针结果。

### G2-c 引用与心跳 — 裁决：降级路径先定，不构成门禁

- `get_msg` 支持：quote 富化，引用机器人可判 `isAtBot=true`。
- `get_msg` 不支持：`quote=null`，`isAtBot` 仅由 `at` 段判定（@机器人可唤醒，引用机器人降级为不唤醒），不阻塞 T04。
- 心跳：有 `meta_event.heartbeat` 用其判定；没有则用 WS 连接状态 + 主动 `get_status` 兜底。

## 2026-11-04 · G2-b 探针结论（正式，替代前述“待探针”状态）

- 证据：`qq-gateway/docs/tasks/G2-PROBE-RESULT.md`（架构师初稿 + 2026-11-04 补测），独立 Tester 复验 PASS（`qq-gateway/docs/tasks/TESTER-REPORT-T00-T01-G2.md` §4）。
- 实测事实：SnowLuma `v2.4.0-node` 安装于 `E:\SnowLuma`，同机；仅监听 `127.0.0.1:3000`（HTTP）、`127.0.0.1:3001`（WS）、`127.0.0.1:5099`（其他），同一 PID；无 token 的 HTTP/WS 均 401；`get_status`/`get_login_info`/`get_version_info` 正常；正向 WS 握手成功并收到 `lifecycle connect/enable`、`heartbeat interval=30000`；`get_msg` 可用（含负 `message_id`）；`httpClients`/`wsClients` 为空，当前未启用 HTTP 回调/反向 WS。
- 裁决（定稿）：
  - 传输固定为**正向 WS** `ws://127.0.0.1:3001/` + `Authorization: Bearer <token>`；网关用 Node ≥24 内置 WebSocket，**零新增依赖**；不引入 `ws`，不做反向 WS/HTTP 回调。
  - HTTP `3000` 仅用于动作（`get_msg`、`get_status` 兜底），不用于事件上报。
  - 心跳以 `meta_event.heartbeat`（30s）为存活信号；`get_status` 兜底。
  - `get_msg` 可用 → quote 富化为生产路径；失败/超时降级 `quote=null`；`isAtBot` = `at` 段命中 self，或 quote 的 `sender.user_id === selfId`；`get_msg` 失败时仅看 `at` 段。
  - `message_id` 一律转字符串并保留负号，禁止 number 透传或取绝对值；eventId 形如 `evt:<selfId>:message:<messageId>`。
- 放行：T03 全量放行（适配器 + 真实 WS + 重连 + online 状态机，立即下派）；T04 核心映射可开工（验收仍需 v1.1 fixtures）。T05–T07 仍等 v1.1 签署。

## 2026-11-04 · CONTRACT v1.1 M3 状态澄清与签署条件

- 磁盘现状：`CONTRACT-v1.1-DRAFT.md`（01:15 更新）§2.4 已写入三条恢复边界——(1) 恢复过滤 `src==='qq' && role==='user' && t>=receiptsSince`；(2) 首次启用持久化 `receiptsSince`，缺水位且已有 Receipt/日志则启动失败、不猜测；(3) 终态 tombstone 持久保留，`prune` 只清内存，重启先排除 terminal。`P2-TASK-CARDS-T2-T5-T4C.md`（01:22 更新）已同步含对应测试断言。
- qq-gateway `TESTER-REPORT-CONTRACT-V1.1-R2.md`（01:12）早于上述修改，其 M3 三处 GAP 结论已过期；不重开全文评审，改为一次 **R3 快核**：只核 §2.4 三边界、strict boolean 分流（`isAtBot` 仅严格 `=== true`）、T2 对应断言、25 fixtures 哈希。
- 本机实测基线（2026-11-04）：`typecheck` 零错误；`npm test` 18 文件 / **150 测试全绿**（T1.6b/T1.5a-r 后）；`node scripts/contract-check.mjs` 25/25 通过。
- 签署条件（全部满足后总负责一次性签署）：R3 PASS；fixtures manifest 复核；`docs/CONTRACT.md` 未被提前修改。签署后放行 T2/T5/T4c。
- T1.6/T1.6b（`appendResult()` 三态 + `isAtBot` 元数据 + duplicate 携带既有 record）与 T1.5a/T1.5a-r 已完成并独立复核（150 tests 证据），无需单独放行。

## 2026-11-04 · R3 PASS 与 duplicate 增量

- qq-gateway R3 快核 PASS：25/25 fixture 哈希一致；§2.4 三边界、`isAtBot` 严格布尔与 T2 断言通过；`docs/CONTRACT.md` 未改。
- ds-memory 已补运行期 `duplicate` 边界：`appendResult.duplicate` 携带既有 L0；仅可恢复 QQ user 记录补建 Receipt，CLI/assistant 或水位前记录返回 `ReserveResult.ignored`，查不到/无效返回 503。
- 证据：`typecheck` 零错误；`npm test` 18 文件 / **150 测试全绿**；`contract:check` 25/25；Tester 独立复核 PASS。
- 当前闸门：duplicate 增量快核通过并由总负责一次性签署后，才放行 T2/T5/T4c；T2 仍未派发。

## 2026-11-04 · CONTRACT v1.1 正式签署与 P2 交付

- 最终 `docs/CONTRACT.md` SHA-256：`B7E2BA63D2DA231F162C9017A709EAA389581261DEF06E1661DB8E89071F4058`；相对签署草案仅改状态行为“v1.1 已签署 2026-11-04”和 §0 G2-b 注记，其余 298 行一致。
- 权威 fixtures 仍为 25 个，`manifest.sha256` 未改写；`contract:check` 25/25。
- T2/T5/T4c 已完成并独立复核 PASS；全量 `npm test` 18 → 25 files / **295 tests 全绿**；`typecheck` 零错误。
- T6 待装配、单实例锁、`/status`、假网关全链路与 CLI 回归。

## 2026-11-04 · CONTRACT v1.1 签署生效

### 条件核对（全部满足）

- `R3-QUICK-CHECK.md` PASS；`R3-DUPLICATE-QUICK-CHECK.md` PASS（duplicate 来源、类型变体、`t` 无效 → 503、`write_error` 脱敏）。
- 本机实测（签署前）：ds-memory `typecheck` 0、18 文件 / **150 tests**、`contract-check` 25/25；qq-gateway `typecheck` 0、8 文件 / **132 tests**、运行时依赖为空。
- 现行契约未提前改动：`docs/CONTRACT.md` SHA-256 `C119F77FB114CD06338E651341EAC8B7213CFE9F5982D4A04E637EA4B660D0BB`，两仓一致。

### 签署

- 签署对象：`CONTRACT-v1.1-DRAFT.md`，SHA-256 `E69869ACF62A054078BE43F7A2809906572323DF7E53EE03600D3220228E3D9E`，作为 v1.1 内容基线。
- 定稿仅允许两处非语义更新：
  1. 状态行改为「v1.1 已签署 2026-11-04」；
  2. §0 的 G2-b 注记更新为已裁决事实（正向 WS `ws://127.0.0.1:3001/`；HTTP `3000` 仅用于动作；G2-c 降级规则保留）。
- 其余任何字段或语义改动均视为新变更，须重新评审与签署。

### 生效动作（顺序固定）

1. ds-memory 将定稿写入 `docs/CONTRACT.md`，报最终 SHA-256。
2. qq-gateway 字节级复制同一文件 + 25 个 `tests/contract/*.json` + `manifest.sha256`，建立 `npm run contract:check` 并校验两仓哈希一致。
3. 哈希一致后 v1.1 生效，v1 进入历史。

### 放行

- 生效即放行：ds-memory T2/T5/T4c；qq-gateway T05/T06。T07 待 T02–T06 完成；T02/T03/T04 继续按既定范围推进。

## 2026-11-04 · 网关三项裁决（T03/T04 收尾）

### 1. T04 `sender.nickname` — card-first

- `sender.card` 非空优先，否则 `sender.nickname`，否则空字符串；`quote.fromName` 同一规则。
- 理由：群聊中群名片是实际显示名，记忆标签更可读；card 缺失自动回退 nickname，不虚构身份。
- 配套：修订 T00 §2.2.2 期望为 card-first；v1.1 fixtures 增加一条含 card 的样例并覆盖 `quote.fromName`。

### 2. T02 配置收紧 — 是

- 配置校验与 T03 运行时共用同一 canonical URL 判定：`ws:` + 字面量 `127.0.0.1` + 端口 `3001` + pathname `/` + 无 query/userinfo/hash；`ws://127.0.0.1:3001` 规范化后等价接受。
- 目的：配置加载即拒绝，fail-fast，不留到建连时。

### 3. T03 CONNECTING 半关闭 — 书面接受为 P2 已知限制（附条件）

- 条件：(a) 应用层口径维持 PASS（stop/timeout 后无 online、无回调/pending 泄漏、停止后不重连、迟到 101 不生效）；(b) 补「stop while connecting」测试；(c) 每次 connect 超时记录 attempt 与状态，连续超时告警；(d) 写入 ARCHITECTURE 风险与残余风险清单。
- 理由：仅本机回环且 SnowLuma 握手异常时触发；重连有界（1s→30s）；网关不代管 SnowLuma；为单一窄竞态引入 `ws` 依赖或自研传输不划算。
- 复评触发：真机验收若观测到 SnowLuma 侧 fd 持续增长，重新裁决（备选 `ws` + `terminate()` 或自管 net 握手）。

## 2026-11-04 · T6/T07 放行与收尾条件

### ds-memory T6 放行

- 范围：常驻装配、单实例锁、`/status`、健康轮询、假网关全链路、CLI 回归。
- 验收前必须完成三项加固：
  1. `EventStore` 的 `onWarn` 注入脱敏 logger，日志/HTTP/`/status` 不得出现绝对路径；
  2. `qq.gatewayUrl` 只接受 `http://127.0.0.1:<port>`（字面量回环、无 userinfo/query/hash；https 拒绝），空值走发现；
  3. 写 assistant L0 前校验 `SendResult` index 不变量（0 起始、无重复、并集等于请求 index）；违例按 `ambiguous_failure`，不得落 assistant 内容。

### qq-gateway T07 放行

- 范围：健康、端点发现集成、单实例、假 OneBot + 假脑全链路、CLI 回归与验收任务卡。
- 先做假传输全链路；真实 SnowLuma/QQ 联调等用户登录后进行，网关不得启动/停止 SnowLuma。
- G7 增补：将 card + quote 成对样例（card-first）纳入权威 fixtures；由 qq-gateway 提案，ds-memory 更新权威集 + `manifest.sha256`，两仓同步并跑 `contract:check`。

### ds-memory commit 授权（一次）

- 入库：T2/T5/T4c 实现与测试、`docs/CONTRACT.md`（v1.1，B7E2…）、`docs/DECISION-LOG.md`、`docs/P2-INTERFACES.md`、`tests/contract/**` 与 manifest、`docs/CONTRACT-v1.1-DRAFT.md`（状态行改为“历史草稿，已被 CONTRACT.md v1.1 取代”后入库）。
- 不入库：`.arts/`、`docs/P2-TASK-BREAKDOWN.md`、`docs/P2-TASK-CARDS-T2-T5-T4C.md`、`docs/CONTRACT-V1.1-REVIEW-RESPONSE.md`（均为各自声明的工作文档）；历史简报可另起 docs commit。
- 不 push。完成后报 commit hash 与 `git status --short`。

### 草案哈希漂移说明

- `CONTRACT-v1.1-DRAFT.md` 当前 SHA-256 `8B9B653C…DEC3366` 与签署基线 `E69869AC…8E3D9E` 的差异仅为状态行（补充“R3 增量已快核”）；最终 `docs/CONTRACT.md`（`B7E2BA63…1F4058`）与草案内容仅差签署允许的两处（状态行、§0 G2-b 注记），签署内容未变。后续以 `docs/CONTRACT.md` 为唯一权威。

## 2026-11-04 · T6 提交授权与 T07 收尾裁决

### ds-memory T6 commit（一次，不 push）

- 入库：`package.json`、`src/config/load.ts`、`src/main.ts`、`src/qq/{client,discovery,hooks,turn,lock,service}.ts`、`src/util/redact.ts`、对应单元/集成测试（含 `tests/unit/lock.test.ts`、`tests/integration/serve.test.ts`）。
- 不入库：`.arts/`、`docs/P2-TASK-BREAKDOWN.md`、`docs/P2-TASK-CARDS-T2-T5-T4C.md`、`docs/CONTRACT-V1.1-REVIEW-RESPONSE.md`。
- 提交信息：`P2 T6: 常驻装配、单实例锁与全链路验收`；正文注明 390 tests、typecheck 0、contract:check 25/25、无新依赖。完成后报 hash 与 `git status --short`。

### qq-gateway T07 收尾

- 端点文件 `file_unreadable`：**fail-closed**——按对端不可用处理并告警，不删除/覆盖、不回退默认端口、不猜地址；记录 `endpoint_unreadable`。
- 在途 `/send` 时 `stop()` 约 3.2s：接受为 P2 已知限制，写入 ARCHITECTURE 风险；要求 stop 后不再发起新发送、在途结果按既定语义收敛、进程在有限时间内退出；另立可选优化任务，不阻塞 P2。
- qq-gateway `/status`：**不要求实现**，保持 404；`/health` 已足够。该项关闭。
- WS 动作路径：保持 WS 3001 为唯一默认动作通道（`send_*`、`get_status` 真机已通过）；`get_msg` 需补一次只读真机验证。若 WS `get_msg` 失败，则整体切换为 HTTP 3000 动作客户端，不得同时保留两套默认路径。
- G7：card + quote 成对样例纳入权威 fixtures 已批准；qq-gateway 提案，ds-memory 更新权威集 + manifest，两仓同步并跑 `contract:check`。
- 真实发送：已完成私聊/群聊各 1 条并验证；新增真实发送需用户再次授权。只读手测不受限。

## 2026-11-04 · 用户权限裁决：群聊仅 owner 可进模型（v1.2）

### 背景与风险

- 当前 SessionMap 只按白名单群放行，群内任意成员 @ 机器人都能进入 wake/模型，存在提示词注入风险。
- 管理员（owner）QQ = `10001`；测试群 = `10002`；机器人 QQ = `10003`。
- `qq-gateway` 保持哑传输，不做权限判断。

### 裁决（必须实现，不得自行放宽）

1. 私聊：只有 `ownerQQ` 私聊可进入模型；陌生人私聊维持 `200 {ok:true}` 静默 ignore（不落 L0/Receipt/会话），不是 403。
2. 群聊：白名单群内所有消息都可持久化到 L0，但只有 `sender.qqId === ownerQQ` 的群消息才允许进入 inbox/wake/模型。
3. 非管理员群消息：`200`（已持久化）、Receipt 终态 `done(outcome=stored_only)`、不调用 provider、不生成 assistant、不发送；无论 `isAtBot` 或 `groupWake="mention"|"all"` 都不得绕过。
4. 管理员群消息：仍受 `groupWake` 约束；`mention` 下需 `isAtBot===true`，否则 `stored_only`；`all` 下管理员消息全部唤醒。
5. 不新增可放开普通群友的配置开关；安全默认不可配置。
6. 非管理员群消息不得进入模型上下文（含检索召回）；L0 必须保留完整原文。
7. L0 新增独立元数据 `senderQqId`、`modelEligible`（**内部 RawRecord 元数据，不进 `/hook`/`/send` 线上字段**）：私聊/管理员群消息 `true`，非管理员群消息 `false`。
8. 旧群聊 user L0 缺 `modelEligible` → fail-closed（不唤醒、不检索）；旧私聊 `src=qq` 且 `sessionKey=private:<ownerQQ>` 可视为 eligible，其他缺字段私聊 fail-closed；CLI 维持原行为。
9. 重启恢复按同一规则重新判定；只有 owner 群消息且满足 `groupWake` 才恢复入队，其余 `stored_only`。

### 理由

- 提示词注入的最小安全边界：普通群友消息只做记忆存档，不进入模型上下文与检索，阻断群内任意成员通过唤醒词/群上下文投喂指令。
- fail-closed：旧群聊记录缺少 `modelEligible` 时宁可只存不取，避免把历史群友内容重新送入模型。
- 网关保持哑传输；`senderQqId` 从既有 `sender.qqId` 派生，线上字段与网关实现零改动。

### 影响与落位

- `docs/CONTRACT.md` 升级为 v1.2（保留 v1.1 历史；§7 增「fixtures 不承载权限/唤醒断言」；§10 为 v1.2 增量）。
- `tests/contract/hook/message-group-mention-valid.json` 仅改 `description`（payload/expect 不变）；`manifest.sha256` 重算。
- `docs/ARCHITECTURE.md`（D8）、`docs/P2-INTERFACES.md`（r4）、`config.example.jsonc` 注释同步。
- qq-gateway 已完成同步（本修订不改 qq-gateway 代码）：`docs/CONTRACT.md`（v1.2）、`tests/contract/hook/message-group-mention-valid.json`、`tests/contract/manifest.sha256` 三份文件两仓 SHA-256 一致——CONTRACT `FDBD1EAC2A619A5731F00F1F7EF90378E62EA6E839A26433EA034876EE3A04B1`；fixture `CB9CE7F366E9DF89D132DAC8B69B877C245A54371EDB49BDFCFE0402073C2CE6`；manifest `0A4E33333326600790E19D97BF4ED581E06DA5C96F4CBCB32657C12A0406E2A7`；两仓 `contract:check` 25/25；qq-gateway `typecheck` 0、304 tests 全绿。

## 2026-11-04 · v1.2 本机上线黑盒验证

### 上线黑盒验证（只读注入，未执行真实 QQ 发送）

- 运行实例：ds-memory PID `24948`（hook `985`）；qq-gateway PID `14052`（`803`，`online`，`selfQqId=10003`）。
- 非 owner 群 @ 注入：`eventId=evt:10003:message:security-test-1793806042794`；HTTP `200`；L0 原文完整，`senderQqId=222333444`、`modelEligible=false`、`isAtBot=true`；Receipt `done/stored_only`；网关该时间后 `send.completed=0`（未产生发送）。
- 陌生私聊注入：HTTP `200`，L0/Receipt 均 0 条（静默 ignore）。
- `/status`：`inbox.pending=0/busy=0`、`gateway=online`。

### 测试口径

- ds-memory `typecheck` 0、`contract:check` 25/25。
- 全量测试在隔离配置 `qq.enabled=false` 下：27 files / 401 tests 全绿。
- 残余风险（测试隔离）：当前本机 live `config.jsonc` 的 `qq.enabled=true` 会使既有 `serve.test.ts > --serve 且 qq.enabled=false` 用例失败（该用例依赖仓库本地配置，非本改动引入）；本次不为此修改生产代码。

## 2026-11-05 · P2.1-G7 关闭、测试隔离与 P3-0 基线

### 裁决与落位

- G7 第 26 个权威 fixture 已落盘：`tests/contract/mapping/message-group-card-valid.json`，`kind=mapping-pair`，覆盖 card-first 的 `sender.card` 与 `quote.fromName`、reply/get_msg 成对映射，不改变线上 JSON 形状。
- `docs/CONTRACT.md` 升级 v1.2.1：fixture schema 增加 `mapping-pair`，fixture 总数 25 → 26；qq-gateway 已字节级同步 CONTRACT、fixture、manifest 与 README，并新增 `tests/mapping/contract-mapping.test.ts` 真实消费该 fixture。
- 测试隔离：`src/main.ts` 新增内部环境变量 `DS_MEMORY_CONFIG_ROOT`（默认仍为项目根，生产行为不变）；`tests/integration/serve.test.ts` 使用临时配置根，不再依赖或改写 live `config.jsonc`。上一节记录的「隔离配置 `qq.enabled=false`」残余风险关闭。
- P3-0 检索评测基线见 `docs/P3-EVAL.md`：Recall@5 = 0.8511（40/47）、MRR = 0.8650、检索隔离负例正确率 1.000。该基线只用于 P3 选型，不构成 P3 验收；不得为提升分数擅自修改生产检索参数。

### 验证口径

- ds-memory：`typecheck` 0 错误、27 files / 401 tests 全绿、`contract:check` 26/26。
- qq-gateway：`typecheck` 0 错误、25 files / 305 tests 全绿、`contract:check` 26/26。
- 两仓四份权威文件哈希一致：`docs/CONTRACT.md` `860A476E29B67393A62D15F270EDFDC48927A0118AFF233AAF04DD1BEB075B5F`；mapping fixture `EC3E4F6BD20346132F203DA9521DAA9671A4CF7882692D7CAD6AFA6185BC0D71`；`manifest.sha256` `3FC5ADDA467FF9649E8ABA66E1475D7BC2F38CD54893102AAC96BC3053A30E66`；`tests/contract/README.md` `B3628D9BEBFBC18C15C9D04BFECCA459E2F5FE942EC260EF8A7EED4190E6974F`。无新增运行时依赖，未 push。

## 2026-11-05 · P3-1 评测方案批准

- 批准 `docs/P3-1-PLAN.md` 作为 P3-1 评测方案，候选顺序 A（Ollama sidecar）→ B（ONNX 进程内）→ C（bge-small-zh-v1.5，仅超预算时）。
- 主审修订门槛：Recall@5 硬门槛 0.93（目标 0.95）且较 P3-0 基线绝对提升 ≥ 0.05；MRR 硬门槛 0.90（目标 0.93）；隔离/负例正确率 1.000；热查询 p50 ≤ 150ms、p95 ≤ 500ms；冷启动 A ≤ 60s / B ≤ 45s；内存增量 A 合计 ≤ 2.5GB / B ≤ 2GB；安装体积 ≤ 2.5GB。
- 安全与运维边界：全部推理仅在本机，消息正文不得发往外部；Ollama 仅访问 `127.0.0.1`，端口由配置/探测获得；ds-memory 不代启动/停止 Ollama，失败自动降级 bigram 且不阻断聊天/L0。
- 当前授权状态：**仅批准方案，不授权下载模型、安装 Ollama 或新增 npm 依赖**；上述动作需用户单独书面授权。

## 2026-11-05 · P3-1 候选 A 实测结论

- 环境：Ollama `0.40.14` + `qwen3-embedding:0.6b`（`Q8_0`、1024 维、`100% GPU`、runner context 4096）；`ollama` 安装目录 3.09GB + 模型 0.60GB = 3.69GB。
- 质量：`Recall@5=0.9149 (43/47)`（P3-0 基线 0.8511，+0.0638）；`MRR(positive-only)=0.9000`（同口径基线 0.8500）；`MRR(all-case)=0.8300`；`isolationLeakCount=0`；无阈值负例弃权正确率 0.200。
- 隔离结论：c33/c34 返回的是 eligible 的 owner 记录 r13/r22/r7，r8/r21 未进入索引；隔离通过，不得把“未弃权”误报为“隔离泄漏”。
- 弃权结论：本数据集上无同时保住召回与负例的全局阈值；`T=0.50` 时负例 1.000，但 `Recall@5` 降至 0.8298（低于 bigram 基线）。阈值必须在独立 dev set 校准，不得用 5 条测试负例调参。
- 资源/性能：冷启动 2.15–2.53s；热查询 p50 14.9–17.5ms、p95 21.4–34.6ms；Ollama+runner working set ≈817MB、Private ≈2.215GB；安装体积 3.69GB 超 2.5GB 门槛；sidecar 破坏单进程约束。
- 裁决：候选 A **不直接替换 bigram**，也不进入 P3-2 实现；下一步只做 hybrid（bigram 精确匹配 + embedding 语义召回 + 独立弃权）方案设计与独立 dev set 评测，不下载新模型、不新增依赖、不改生产代码。若安装体积为硬约束，再评估候选 C（需新的下载授权）。
- 评测产物：`tests/eval/run-embedding-eval.ts`、`docs/P3-1-REPORT-A.md`；未改 `src/`、`package.json`、`docs/CONTRACT.md`、`tests/eval/cases.json`；随本文件所在提交入库，未 push。

## 2026-11-05 · Ollama 迁移到 E 盘

- 用户要求不占用 C 盘：程序从 `%LOCALAPPDATA%\Programs\Ollama` 迁至 `E:\Ollama`，模型迁至 `E:\Ollama\models`。
- 迁移前逐文件 SHA-256 校验 6/6 一致；随后卸载 C 安装并删除 C 模型目录。C 盘仅保留 `C:\Users\demo\.ollama` 的密钥/标记约 2.5KB。
- 用户环境已更新：PATH 移除旧 C 路径并加入 `E:\Ollama`；`OLLAMA_MODELS=E:\Ollama\models`。
- 已从 E 盘启动 `ollama serve`，验证 1024 维 embedding、模型加载自 `E:\Ollama\models\blobs`、`100% GPU`。
- 未设置开机自启（旧启动项随卸载移除）；手动运行 `E:\Ollama\ollama app.exe`（托盘）或 `E:\Ollama\ollama.exe serve`（前台/后台服务）。

## 2026-11-05 · P3-2 hybrid 评测结论

### 数据修正

- 发现 P3-0/P3-1 数据集 `cases.json` 的 `c13/c14/c19/c20` session 写错：从 `cli:owner` 查询 `private:10001` 的记录，属于不可能命中。原文件保留，新增 `cases-v2.json` 只修正这 4 条。
- 修正后的 bigram 基线为 `Recall@5=0.9362 (44/47)`、`MRR=0.9450`；P3-1 记录 `0.8511` 与 `0.9149` 的解释不再成立，已在 `docs/P3-EVAL.md` §7 与 `docs/P3-1-REPORT-A.md` 加勘误。

### 设计与实测

- 采用 bigram 与 embedding 双候选（各 top 20）+ 独立证据门 + `0.25/0.75` 融合排序 + 精确标识符加成；不引入全局相似度阈值，不使用新的运行时依赖，不修改 `src/`。
- 证据门：数字/英文硬锚点精确命中直接放行；中文 bigram/评测别名组无任何命中则弃权；多个证据槽分散在不同记录、没有单条记录覆盖两个槽则 `split-evidence` 弃权。
- dev set：hybrid `Recall@5=1.0000`、positive MRR `0.9875`、负例正确率 `1.000`；修正回归集：`Recall@5=1.0000 (47/47)`、positive MRR `1.0000`、负例正确率 `1.000`、`isolationLeakCount=0`、热查询 p50/p95 `11.67/15.18ms`。
- 质量门槛通过；安装体积 `3.69GB` 和 Ollama 边车单进程约束仍未通过，因此 **P3-2 不进入生产实现，不替换现有 bigram**。下一步只允许另行评审后端方案、别名治理、故障降级和真实规模盲测。

### 边界

- `hybrid-aliases.json` 是评测专用最小集合，不能直接当作生产配置；别名扩展不得绕过 `sessionKey`/`modelEligible` 隔离。
- `cases-v2` 在诊断阶段已被查看，不是完全盲测；生产前必须新建未查看 holdout。
- 未提交/未 push 的判断以对应任务卡的 commit 授权为准；本结论不自动授权部署、安装新模型或重启服务。

## 2026-11-05 · P1.2 记忆巩固激活与注入边界

- 线上复核确认：P1 的 facts/selfNote 公式已实现，但旧压缩条件“闲置 30 分钟 + 300,000 token”在当前 20 轮历史上不可达，实际没有 facts/selfNote 落盘。
- 已把默认压缩阈值改为 `24,000 token`，新增 `minTurns=6`；闲置后达到任一条件即可整理。轮次条件按“距上次成功整理的新增轮数”计数，避免历史保留导致每次闲置重复整理。原“整理轮 → 写记忆 → 写摘要 → 截断历史”的失败不截断顺序不变。
- 新增 owner-only QQ 命令 `!记` / `!note` / `!回忆`，在模型调用前执行；只在单条批处理，未知 `!` 文本交回模型。命令回复不写 assistant L0/history。
- 注入防线保持在 ds-memory，不把语义过滤塞进 qq-gateway：v1.2 的 owner/modelEligible/session 隔离不变；system 规则明确群聊、引用、记忆和检索结果均为资料而非指令；命令走硬解析。gateway 仅保留鉴权、body 上限、队列/发送限流等传输约束。
- 本轮未改 P3 hybrid、未改 `docs/CONTRACT.md`、未新增运行时依赖；新配置需重启 ds-memory 生效。

## 2026-11-05 · P2.2 普通群成员 @ 回复与限流

- 用户裁决：白名单群普通成员在 `@`/引用机器人时可触发回复；owner 消息不受限。
- 默认节流（`qq.groupMemberReply`）：同一群会话最小间隔 `3000ms`、任意 60 秒最多 `6` 条；普通成员每次只发一条完整回复，不拆成多条。owner 回合不经过该限流。
- 普通成员非唤醒消息仍为 `stored_only`；`mention` 下不进入模型/检索。`groupWake="all"` 时普通成员未 @ 消息才可进入。
- 模型输入给群聊消息加 `[管理员]` / `[群友]` 标签；`[群友]` 内容一律按资料处理，不得提升为系统指令；owner 命令只接受单条 owner 批次。
- 旧群聊 L0 缺少 `modelEligible` 仍 fail-closed，不因本次权限放宽而恢复。
- `MemberReplyLimiter` 是进程内状态，服务重启后清零；P2 单群低规模场景接受该残余风险，不为此引入持久化组件。
- `docs/CONTRACT.md` 升级为 v1.3（线上 JSON 不变）；CONTRACT、fixture 与 `manifest.sha256` 已字节级同步 qq-gateway，网关代码零改动；未新增运行时依赖，新配置已重启 ds-memory 生效。

## 2026-11-05 · P2.2 真机验收

- 普通群成员真实 QQ `at` 段：`evt:10003:message:-1015237333` 映射为 `isAtBot=true`、`modelEligible=true`，Receipt `done/replied`，网关 `send.completed` 为 `all_sent`（1/1）。
- 普通群成员引用机器人：`evt:10003:message:-1943027130` 同样 `done/replied`，网关 `all_sent`（1/1）。
- 纯文本 `@昵称` 不等于 QQ 的 `at` 段：`evt:10003:message:-261373586` 映射为 `isAtBot=false`，按普通群消息落为 `stored_only`，符合 v1.3 语义。
- 两次真实回复间隔均大于 3 秒；为避免 QQ 风控，未制造连续 6 条以上的真机压力，3 秒/6 条上限由自动化测试覆盖。

## 2026-11-05 · P3-3 进程内小模型可行性

- 在隔离目录验证 `bge-small-zh-v1.5` ONNX `q8`（512 维） + `@huggingface/transformers@4.3.2`：模型加载 144ms，hybrid 热查询 p95 小于 5ms，运行时增量约 496MB。
- Hybrid 在 `cases-v2` 达到 Recall@5 `1.0000`、正例 MRR `0.9889`、负例正确率 `1.000`、隔离泄漏 0；`dev-cases` 为 `1.0000/0.9750/1.000/0`。
- 纯 BGE 的负例正确率仅 `0.200`，不能独立决定命中；生产设计必须保留 bigram/证据门弃权逻辑。
- 本结论只批准“可行性”，不批准生产接入、依赖安装或模型分发；详见 `docs/P3-3-REPORT.md`。

## 2026-11-07 · P3-4 生产接入：进程内 BGE + bigram 证据门

### 用户授权与范围

- 用户批准 P3-4 生产实现：默认关闭的 embedding 开关、进程内 BGE、不使用向量库、保留 bigram/词法证据门、模型缺失/哈希错误/推理失败自动回退、模型哈希校验。
- `memory.recall.engine` 是唯一开关：`bigram`（默认）或 `embedding`。不新增第二个 `enabled` 开关，避免配置互相矛盾。
- 新增直接运行时依赖 `@huggingface/transformers@4.3.2`（精确版本，Apache-2.0）；直接运行期依赖 2 个（zod + transformers），仍 ≤5。安装后 `node_modules` 约 527MB。
- 模型不入 git：仓库只提交 `models/bge-small-zh-v1.5-onnx/{README.md,manifest.json}`；二进制放模型目录（本机 `E:\workspace\.models\bge-small-zh-v1.5-onnx`）。运行时信任锚是 `src/memory/retriever/embedding-model.ts` 中的 5 个 SHA-256，不读取可被篡改的 manifest 作为信任源。

### 实现边界

- `BgeSmallZhEmbedder` 首次检索才动态加载 native runtime；`allowRemoteModels=false`，不联网下载。加载前校验 `config.json`、`tokenizer_config.json`、`tokenizer.json`、`onnx/model_quantized.onnx`、`onnx/model_quantized.onnx_data`。
- `HybridRetriever` 先取 bigram 候选，再执行证据门；只有证据门放行才加载模型。数字/英文硬锚点直接放行；无词法证据弃权；多槽证据分散在不同记录时 `split-evidence` 弃权。
- 融合权重固定为 `0.25 × 词法归一 + 0.75 × 语义归一 + 硬锚点加成`，近因只作 tie-break；保留 80 字去重和 400 字注入截断。
- 失败策略：模型缺失、哈希不符、native 加载失败、推理异常 → 一次明确告警，本进程永久回退 bigram；不阻断聊天、L0、CLI 或 `!回忆`。重启后才重新尝试。
- 三条入口（CLI、`--serve`、QQ service）统一经 `createRetriever()` 接线；`engine=bigram` 时不构造 embedding 运行时。
- 会话隔离与 `modelEligible` fail-closed 复用 `BigramRetriever.docsForSession()`，未复制第二套权限判断。

### 生产别名与证据门修正

- 新增受控 `PRODUCTION_ALIASES` v1（GPU/电脑/屏幕/语言/宠物/日料/价格/不喜欢/分辨率）；别名只扩展证据门，不直接产生命中。未收录「叫」「块」「元」「花了」等过宽词。
- 实测发现「一次」等疑问/时间短语会造成假 `split-evidence`；新增 `STOP_TERMS`，并允许非虚词单字（如「猫」）作为证据。
- 生产检索不使用 `tests/eval/hybrid-aliases.json`；该文件仍仅用于旧评测对照。

### 实测

- 新构造 holdout（17 cases / 16 corpus，非独立盲测）：Recall@5 `1.0000`、正例 MRR `1.0000`、负例正确率 `1.000`、p50/p95 `2.58/3.27ms`。
- `cases-v2`：Recall@5 `1.0000`、正例 MRR `0.9889`、负例正确率 `1.000`、p50/p95 `3.71/6.11ms`。
- `dev-cases`：Recall@5 `1.0000`、正例 MRR `0.9750`、负例正确率 `1.000`、p50/p95 `4.21/15.35ms`。
- 真实模型加载约 `211–384ms`；默认关闭时自动化测试不加载模型。

### 残余风险

- holdout 由本轮构造，不是独立盲测；不能据此宣称线上分布已无盲区。
- `npm audit` 报 2 critical / 1 moderate，均来自既有 devDependency `vitest@3.x → tinypool/@vitest/mocker`，不是本次 transformers 引入；修复需升级 vitest 大版本，另立任务。
- 模型二进制与 native runtime 的平台兼容性只在当前 Windows x64 / Node 24 验证；其他平台需重新冒烟。
- 生产别名表是人工维护的小集合，新增别名必须补测试，不得把评测别名文件直接复制上线。

## 2026-11-07 · P1.3 记忆巩固与可塑性

### 裁决

- 会话状态扩展为 `summary + lastActiveAt + history + turnsSinceCompaction + lastTurnAt`。history 只存真正进入过模型的 user/assistant 原文，最多 `historyTurns × 2`；旧 JSON 缺字段兼容。每轮结束与 `commitAssistant` 成功后原子写回，重启后继续自动整理边界。
- 普通会话状态写失败只告警一次，不阻断聊天；压缩流程仍保持“记忆写盘成功 → 摘要/状态写盘成功 → 才截断历史”，任何失败不截断。
- 新增 owner-only `!整理`（CLI + QQ）。无参数，绕过 idle/token/minTurns，复用 `runCompaction`；命令回复不写 assistant L0/history，不回显模型 JSON。整理失败不截断历史。
- facts 新增保守冲突降权：同 session、同 tag、未归档；按标点/转折词分句，归一化内容主体（去掉语气/时态/转折/否定噪声与情感谓语，保留主语和具体对象；仅容忍主语省略差异，不把不同显式主语互相判定；多分句省略主语继承前序显式主语）。三态：同一主体相反极性且无同极性确认 → `conflict`；有否定/负面情感但主体不明确、主体不同、主客倒置或双重/叠加否定（含 `未/从未/并未`）中性 → `uncertain`（不降权、不复习）；同主体同极性或无极性冲突 → `no-conflict`（允许正常复习）。命中 `conflict` → 旧 fact `baseWeight *= 0.5` 并写 `conflictedAt`，保留原文/复习/时间，不删除。每条旧事实最多降权一次；`autoReview` 只强化 `no-conflict`。
- 手动整理成功后重置闲置锚点，避免保留的最近 2 轮仍超阈值时下一条消息立即重复整理。
- 本轮不改 `docs/CONTRACT.md`、qq-gateway、配置默认值或运行时依赖；线上 JSON 形状不变。

### 仓库修复

- 发现 `.gitignore` 的 `state/` 未锚定，误忽略 `src/state/`，导致 `paths.ts`、`persist.ts` 从未被 Git 跟踪，全新克隆缺少源码。已改为 `/state/` 并将两个源码文件纳入版本控制。

### 验证

- `typecheck` 0 错误；`npm test` 32 文件 / 474 测试全绿；`contract:check` 26/26；`git diff --check` 通过。
- 新增覆盖：旧 state 兼容、history 非法项过滤、状态写失败不阻断、重启恢复 history/计数并继续压缩、`commitAssistant` 后恢复实际送达、`!整理` 成功/失败/未接线、QQ 真实 `runQqTurn` 接线、手动整理绕过边界与重置锚点、摘要写失败不截断、冲突降权/不同 tag/同文本/二次冲突/短事实/相关反义与无关同极性分句/`而不`分句/同极性具体对象/同义否定不冲突/同极性确认与反义分句并存仍判冲突/叠加否定中性/未类否定/多分句主语继承/裸主语与状语变体不跨主体/同主体状语反义仍降权/autoReview 防误强化/同主语正常再提及排序。

### 残余风险

- `autoReview` 当时的 gram 触发限制与 CLI `!整理` 未绑定 `activeAbort` 的残余风险，已由下方“2026-11-07 · autoReview 精确匹配与 CLI 整理中断”节取代。
- 压缩非事务：摘要写失败时 facts/selfNote 可能已写入，历史不截断、不回滚。
- 未启动/停止 SnowLuma、未启动真实 QQ 链路；`!整理` 真机回执待部署后观察。

## 2026-11-07 · autoReview 精确匹配与 CLI 整理中断

### 裁决

- `autoReview` 在原有 `classifyConflict === 'no-conflict'` 与 gram ≥ 0.5 之外，新增“同主体、同 core”门禁；不同显式主体、不同对象、主客倒置不复习。新消息以并列连接词（和/与/、/及/跟/以及）在旧事实对象后追加实际内容时，允许单向复习；旧事实更长、新消息只复述子项时不复习，避免确认未提到的对象。
- 比较用归一化仅用于主体/core，不改事实原文、注入内容或公开 JSON 形状。接受“他挺喜欢猫”等口语变体漏复习，以换取“挺过去/张挺”不被错误折叠；这是显式保守取舍。
- CLI `!整理` 将外部 AbortSignal 贯穿 `requestCompaction`；Ctrl+C 后不写 facts/selfNote、不截断 history，且不计入压缩失败防抖。真正超时、网络错误、非法 JSON 仍走原失败路径。

### 验证

- `typecheck` 0 错误；`npm test` 32 文件 / 487 测试全绿；`contract:check` 26/26；`git diff --check` 干净（仅 LF→CRLF 提示）。
- 覆盖同主体/异主体、同对象/异对象、主客倒置、强调词、并列扩展、反向删减、空扩展、选择关系、冲突/不确定门禁，以及 CLI 中断不写记忆/不截断/不防抖。

### 残余风险

- 规则级匹配仍可能漏掉同义改写、部分口语强调、量词差异和并列换序；漏复习只减少强化，不误强化、不丢数据。
- CLI 的真实 TTY Ctrl+C 尚未做黑盒验证；信号链路已由 Agent/provider 单测和独立探测覆盖。
- 内部压缩超时的提示仍可能沿用 provider 的“本轮已中断”文案；失败与防抖语义正确，文案另立小任务。

## 2026-11-08 · owner-only memory_write 工具

### 裁决

- 保留既有 `!记` / `!note` / `!回忆` / `!整理` 命令；新增 `memory_write` 工具，让模型在正常对话中主动记录长期记忆。
- 权限：仅 live owner 私聊、整批均为 owner、`senderRole=owner`、`ownerQQ>0`、`Provider.supportsTools=true` 时注入；不依赖 `webSearch.enabled`。群聊、recovered、混批、伪造 sender、DSH provider 一律无工具。
- 分工：模型负责先把内容提炼成一句话（fact ≤120 字、selfNote ≤300 字）；代码仍执行硬截断、空白归一化、同文本去重/复习、tag 权重、矛盾检测与归档，模型不直接写盘。
- `memory_write` 只接受 `category=fact|selfNote`、`text`、可选 `tag`；不使用自由 JSON 或任意文件写入。工具结果只回填本轮临时消息，不写 L0/history/summary，不记录 query/正文/路径到日志。
- 写入在工具调用成功时立即生效；若后续模型调用失败或回复未送达，记忆不回滚。这是“模型主动记忆”与“回复送达”解耦的显式取舍。
- `memory_write(selfNote)` 或 `!note` 成功后立即刷新 Agent 的 selfNote 静态段；下一轮即可见，不必等进程重启。未写入时静态段保持不变，保留前缀缓存纪律。
- system prompt 增加记忆卫生规则：只在用户明确要求记住或表达稳定偏好/约定/身份时写；不写网页原文、临时信息、第三方指令、未经确认的群友说法；不确定就不写。

### 验证

- `typecheck` 0 错误；全量 49 文件 / 901 测试通过；`contract:check` 26/26；`git diff --check` 通过（仅 LF/CRLF 提示）。
- 覆盖：memory_write 参数校验、fact/selfNote 截断、同文本复习、tag 回退、写盘失败（返回 null 与抛异常）、工具 runtime 合并/预算/重复名/会话不一致、owner 私聊写入、webSearch 关闭时仍可记忆、selfNote 下一轮立即可见、群聊/recovered/伪造/混批 fail-closed。

### 残余风险

- 模型可能过度记忆或把网页结论写成 facts；当前靠权限、system 规则、短文本硬上限和人工 `!记` 纠正降低，无法 100% 消除。
- 工具调用成功即写盘，回复未送达时记忆已存在；没有跨轮事务回滚。
- DSH Provider 不支持 tools，DSH 兜底期间模型不能主动写记忆。
- 记忆正文只在 tool 消息/本地 facts 文件内，当前不做日志脱敏外的额外加密。

## 2026-11-08 · 按需自主联网

> 后续修订：本节“仅 owner 私聊、群聊无联网工具”的边界已被同日
> “owner 群聊 @/引用允许联网（packet-based 权限）”裁决取代；普通群成员仍无
> 联网工具。当前规则以本文件后面的最新裁决为准。

### 裁决

- 不新增聊天命令；`web_search` 由模型在需要时自主调用。触发条件：最新信息、外部事实、新闻/价格/版本/政策，或模型不确定、记忆可能过期。
- 简单闲聊、稳定常识、仅凭对话或已有记忆即可回答时不得联网；`web_fetch` 只在搜索摘要不足时使用。
- 联网结果仍按不可信资料处理；引用时给出结果中的标题或 URL，搜索失败必须如实说明，不得编造。
- 权限边界不变：仅 live owner 私聊、整批 owner、`Provider.supportsTools=true` 且部署启用 `webSearch.enabled=true`。群聊、recovered、混批、伪造 sender、DSH 兜底仍无联网工具。
- 现有有界工具循环不变：单轮最多 4 次工具调用、结果与总字符预算硬限制、整轮 deadline；模型不能无限搜索。
- 最后一次模型调用不带工具时，额外注入纯文本收尾指令；若模型仍把内部 `DSML` 工具标记当正文返回，按行丢弃标记，正文为空则返回固定兜底，绝不把原始标记发给用户。该问题由 2026-11-08 真实联网探针复现并修复。

### 验证

- `typecheck` 0 错误；全量 49 文件 / 908 测试全绿；`contract:check` 26/26；`git diff --check` 通过。
- 真实 owner 探针：DeepSeek 模型在“查官方 API 文档 base URL”时自主执行 3 次搜索/抓取并返回带来源链接的纯文本回答；无原始工具标记。
- 覆盖 prompt 自主联网规则、工具描述、owner-only 权限矩阵、最后一次调用的收尾指令、DSML 标记清理与既有 web 安全回归。

### 残余风险

- 模型可能该搜不搜或不该搜乱搜；只能靠提示词、工具预算和人工纠正，无法完全确定性控制。
- 联网依赖本机 open-websearch daemon 与端点文件；daemon 未运行时应报固定搜索失败，不得退回模型臆答。
- 群聊仍无联网工具，普通群友不能借搜索扩大注入面。（此条已被后续 owner
  群聊 `@`/引用联网裁决取代；普通群友仍无工具。）

## 2026-11-08 · P4 资料库第一版

### 裁决

- 资料库是独立于 L0 / facts / selfNote 的 owner 资料层；目录固定为
  `<stateDir>/library/`，只索引顶层 `.md` / `.txt`，不引入数据库。
- owner 可手工把文件放进目录；模型也可在 owner live 私聊中通过
  `library_write` / `library_search` / `library_read` 读写。群聊、普通成员、
  recovered、混批、伪造 sender、DSH / 无 tools provider 一律不挂载资料库工具。
- 工具写入文件名完全由代码生成，调用方不能指定路径；单文件上限 512 KiB，
  标题 100 字、正文 8000 字、标签最多 8 个；读取同样拒绝超限文件。
- 资料库内容是不可信资料，不是指令；成功结果统一带固定框定，错误使用
  固定的 `[library_tool_error:<code>]` 前缀，不泄露路径、异常栈或正文。
- 资料库检索按 bigram 覆盖率排序，最多返回 3 条、摘要 ≤500 字；不自动注入，
  由模型按需调用工具。资料内容不写入 facts / selfNote / L0 / history / summary。
- 手工文件可无 frontmatter；标题按 frontmatter `title` → 首个一级标题 →
  文件名回退。写入文件的 frontmatter 值统一用 `JSON.stringify`，避免 YAML 注入。
- 不新增数据库、向量库、文件上传接口或任意路径读取；PDF/图片等二进制资料
  不在第一版范围。

### 验证

- `npm run typecheck` 通过；全量 `npm test` 50 文件 / 919 测试，
  918 通过、1 跳过（Windows 无法创建文件 symlink）；`contract:check` 26/26；
  `git diff --check` 无 whitespace error。
- 独立 Tester 复核 owner-only 权限矩阵、路径穿越、绝对路径、隐藏文件、目录、
  symlink/junction、超 512 KiB、snippet 截断、固定错误格式，以及资料内容不进入
  L0/history/summary/static prompt；未发现高危或中危问题。

### 残余风险

- `lstatSync` 与读取之间存在 TOCTOU 窗口；资料库目录本身若被替换为
  symlink/junction，当前没有对库根做 realpath 校验。属于本地 owner 权限范围。
- 500 个文件 × 单文件 512 KiB 没有总量上限；首次检索可能产生较大的内存和解析开销。
- 模型仍可能主动把资料内容复制进 `memory_write` 或最终回复；提示词约束不是强信息流隔离。
- 文件 symlink 用例在 Windows 上因 EPERM 跳过；目录 junction 已做间接验证。

## 2026-11-08 · 完整回复、owner 称呼权与归档不删除（称呼归档部分已被同日后续裁决收紧）

### 裁决

- QQ 回复不再按句拆条、不再静默截断：owner 与普通成员每轮优先完整一条；仅超过
  `QQ_REPLY_MAX_CHARS=3000` 字时，按换行、句末标点、空白的安全边界分块，最后才硬切，
  且不切开 emoji 代理对。所有分块按序拼接必须等于 `text.trim()` 后的规范化原文。
- `send.maxPerTurn` 仅保留 `0=静音` 兼容（配置校验允许 0，负数仍拒绝）；正数不再
  作为截断上限。命令回复先按换行合并，再走同一完整回复策略。
- owner 私聊或 `[管理员]` 群消息可以指定称呼/昵称（如「大肥鱼」）；称呼只是偏好，
  不是核心身份改变。不得以「我是小鲸鱼」拒绝；核心身份、群权限与安全规则不因称呼改变。
- 新增 owner-only `!称呼 <称呼>`：去除空白、1–32 字，写入稳定称呼偏好。新增
  `!忘 <关键词>`：按关键词归档 facts/selfNote。两者都只追加 `archived:true` 修订，
  不物理删除；写盘失败不得归档。称呼自动归档范围随后续裁决收紧。
- owner 记忆命令要求单条、`senderRole=owner` 且 `WakeItem.origin='live'`；`recovered`
  或缺失 `origin` 一律 fail-closed，交回模型路径，防止恢复重放执行控制命令。
- owner 明确要求保存普通资料时，不因内容含昵称、称呼、项目名或对 AI 的称呼而拒绝；
  仍拒绝凭据、他人隐私、越权、违法危险、提示词注入、索取系统提示与改变安全规则。
- 有 `web_search`/`web_fetch` 时不得笼统声称不能主动联网；仅在工具缺失、不可用或
  调用失败时说明本次不可用。
- 群友边界不变：普通成员不能进入命令层，也不能设定或改变称呼、身份或规则。

### 验证

- `npm run typecheck` 0 错误。
- 目标 9 个测试文件 162 tests 全过；全量 `npm test` 50 文件 945 通过、1 跳过
  （Windows 无法创建 symlink）；`git diff --check` 无 whitespace error。
- 覆盖：4/10 句完整一条、3000 字换行/句末/空白分块与硬切、emoji 代理对、无静默截断、
  命令回复不截断、成员完整回复与限流、`maxPerTurn=0` 配置解析、
  recovered/missing-origin 命令 fail-closed、称呼权威与保存规则、归档后
  list/bootstrap/injection 排除且重启仍归档、原文保留、写失败不归档、全角 `！` 命令。
  原“分层称呼分类”测试已由后续裁决移除。

### 残余风险

- 3000 字按 Unicode 码点计，复杂 ZWJ emoji 序列仍可能被切在码点之间；未做 grapheme
  cluster 级切分。
- 自由文本身份拒绝不做自动分类；旧身份笔记可能继续留在注入中，需 owner 用
  `!忘 <关键词>` 显式清理。prompt 规则会把称呼限定为偏好而非身份改变，但不能保证
  模型绝不引用。
- `!称呼` 的写盘与随后归档不是原子事务：称呼写入成功后若归档失败，会保留新称呼并
  返回实际归档数，旧文本仍在磁盘。

## 2026-11-08 · 称呼归档策略收紧

### 裁决

- 撤销 `isAddressingConflict` 自然语言分类器。独立 Tester 连续发现项目/技术命名、
  转述、疑问句、标点与空格变体被误判，自动归档会把仍在使用的 facts 从注入中移除。
- `!称呼` 只归档此前由命令自动生成、且以 `主人指定的称呼是` 开头的旧称呼偏好；
  不根据自由文本猜测“身份拒绝”，不自动归档任何 facts。
- 旧身份/旧称呼类记忆由 owner 用 `!忘 <关键词>` 显式归档。两者仍只追加
  `archived:true` 修订，不物理删除。
- `SelfNoteStore.bootstrapText` 只展示最新一条称呼偏好，并放在独立的
  `【主人当前指定的称呼】` 区块，明确“优先于旧自认知中的称呼坚持”；旧自由文本
  selfNote 仍保留，但不再拥有称呼解释权。

### 验证

- `npm run typecheck` 0 错误；`contract:check` 26/26；`git diff --check` 无
  whitespace error。
- 相关 10 个测试文件 173 tests 全过；全量 `npm test` 50 文件 944 通过、1 跳过
  （Windows 无法创建 symlink）。全量首跑触发一次既有的 tinypool
  `ERR_IPC_CHANNEL_CLOSED` teardown 抖动，标准命令复跑一次通过，无断言失败。
- 覆盖：`!称呼` 只归档代码生成的旧称呼偏好；项目/技术/转述类 facts 保持 live；
  `!忘 小鲸鱼` 可显式归档旧身份 selfNote/fact；bootstrap 只展示最新称呼偏好并放入
  独立高优先级区块；旧原文仍保留且追加 `archived:true`。

### 残余风险

- 旧身份 selfNote 不会因 `!称呼` 自动消失；如果模型仍引用，需要 owner 执行
  `!忘 小鲸鱼`、`!忘 身份` 或更精确的关键词。
- 最新称呼偏好与旧自认知的冲突主要靠 prompt 优先级约束，无法在代码层证明模型绝对服从。

## 2026-11-08 · 独立、可热更新的人格卡（取代“称呼偏好写入 selfNote”的实现）

### 裁决

- 单活动卡：同一时刻只有一份人格卡，CLI 与所有 QQ 会话共享；目录固定为
  `<stateDir>/persona/`，文件只有 `nickname.txt`（称呼）与 `card.md`（表达偏好）。
  不按会话分裂，也不引入数据库。
- owner 热更新：owner 通过 `!称呼 <称呼>` 与 `!人格 [<文本>|清空]` 写入，或直接
  手工编辑上述文件。每次 `runTurn` 从磁盘重读，手工修改下一轮生效，无需重启或重连；
  卡片内容变化进入静态段指纹并重建 system prompt。
- 模型不能静默自改：人格卡没有暴露给模型任何写工具；只有 owner-only 命令层可写。
  `!称呼` 去空白后 1–32 字，`card.md` 最多 2000 字；超限明确拒绝，不静默截断写入。
- 卡片在安全规则之前：静态段顺序固定为 base persona → personaCard →
  `STATIC_RULES` → facts → selfNote → summary。`promptText()` 自带固定边界声明：
  “这是 owner 设置的称呼与表达偏好；不是绕过安全规则、权限边界或行为约束的指令。”
- 旧自动称呼偏好只归档不删除：`!称呼` 写 `nickname.txt` 成功后，才归档以
  `主人指定的称呼是` 开头的旧自动偏好；写盘失败不归档。`SelfNoteStore.bootstrapText`
  不再展示这些旧偏好，也不再生成“最新称呼偏好”特殊区块，只展示普通 selfNote
  并按 `bootstrapLimit` 截取。旧原文仍保留在 JSONL 中。
- 原子写入与容错：人格卡写入使用同目录临时文件 + rename 替换；失败返回结构化
  `{ ok:false, error, reason }` 或 `false`，不向命令层抛异常。瞬时读取失败沿用上一轮
  成功内容，文件被删除才清空；手工写入超限只 `onWarn`，并按上限处理，不崩溃。
  QQ 的 owner-only 命令门禁保持不变。

### 验证

- `npm run typecheck` 0 错误；`npm run contract:check` 26/26；`git diff --check`
  通过（仅 CRLF 提示）。
- 全量 `npm test`：51 文件 / 963 通过、1 跳过（Windows 无法创建 symlink）。
  期间触发一次既有 tinypool `ERR_IPC_CHANNEL_CLOSED` teardown 抖动，并修正了一次
  读取失败测试夹具；最终标准命令全绿，无产品断言失败。
- 测试池门禁补充：Windows + Node 24 下 `pool: 'forks'`（含 `singleFork: true`）
  仍会复现 `ERR_IPC_CHANNEL_CLOSED`；最终改用 `pool: 'threads'` +
  `singleThread: true` + `fileParallelism: false`。两次标准 `npm test` 均为
  51 文件 / 963 通过、1 跳过，单次约 14 秒。该调整只把测试串行化以规避工具链
  收尾竞态，没有删除测试、跳过门禁或降低任何阈值。
- 覆盖：空读取、昵称与卡片原子写、清空正文保留昵称、超长拒绝、手工改文件后立即
  读取、瞬时读失败沿用上一轮成功内容、promptText 固定框定、空卡空串；Agent 每轮
  刷新与静态段指纹；QQ
  `!称呼`/`!人格` 命令、写失败不归档、回调与下一轮 system prompt 热更新；
  selfNote 冷启动不再展示旧自动称呼偏好。

### 残余风险

- 人格卡是全局单卡，不能为不同群或会话配置不同人格；这是本裁决的明确取舍。
- 卡片只是 prompt 层的表达偏好，无法在代码层证明模型绝对服从；安全边界仍依赖
  `STATIC_RULES`、权限判断与工具 deny-by-default。
- 原子 rename 依赖同目录与同卷；Windows 上杀毒/文件锁等外部因素仍可能让写入失败，
  此时命令明确报错，旧卡保持原样。
- 手工修改只在下一轮生效，当前生成中的回合不会中途换卡；没有文件监听器。

## 2026-11-08 · owner 群聊 @/引用允许联网（packet-based 权限）

### 裁决

- 联网工具从“仅 owner 私聊”扩展为“owner 私聊 + 白名单群内 owner `@`/引用机器人”。
  普通群成员即使 `@` 也没有联网工具；非白名单群、owner 未 `@`/引用、recovered、
  缺 sender、伪造 sender 一律 fail-closed。
- 权限改为在 `buildWakeBatch` 成功后，按 `wake.packet.items` 的 `eventId` 回查
  原始 `InboxItem` 判定；`isAtBot` 以原始条目为准，不用 WakeItem 反推。
- 只写 L0 的成员消息不参与授权，不能误伤同批 owner 回合；任一 included 成员
  条目使整包无联网工具。被 wake 省略的条目留给下一批，本批不受其影响。
- 私聊语义保持不变：会话 `private:<ownerQQ>`，included 全部为 live owner 私聊。
  群聊要求 included 全部为白名单群 live owner 消息，且至少一条 `isAtBot=true`。
- 记忆工具不扩展：仍仅 live owner 私聊，`senderRole=owner`、整批 owner；
  群聊 owner 获得联网工具时也不会获得 `memory_*`/`library_*`。
- 不改 qq-gateway、`docs/CONTRACT.md`、公共契约、依赖、`package.json` 或
  lockfile；部署开关仍为 `webSearch.enabled`。

### 验证

- `npx vitest run tests/integration/qq-websearch.test.ts`：21/21 通过。
- `npm run typecheck`：0 错误。
- `npm test`：51 文件通过；969 通过、1 跳过（Windows 无法创建 symlink）。
- `npm run contract:check`：26/26 通过。
- `git diff --check`：无 whitespace error（仅 Git 的 CRLF 提示）。
- 覆盖：owner 群 `@` 有 web 无 memory；owner 群未 `@`（`groupWake=all` 亦然）
  无工具；普通成员 `@` 无工具；owner/成员混包无工具；`groupWake=all` 下 owner
  `@` 与成员普通消息同包也无工具；owner `@` 时成员未唤醒消息只存、不进入
  modelText；recovered owner 群无工具；伪造 owner 群 sender 无工具；owner 私聊
  web+memory 回归。`t1-w4` 验收中旧的“群聊无工具/第 13 条省略即整批失效”
  断言已按 packet 语义更新，未放宽成员或 recovered 边界。

### 残余风险

- owner 群聊入口比私聊多出群内引用与多人上下文，提示词注入面略大；仍按
  不可信资料处理，且成员消息只在非唤醒时 stored-only。
- 群会话历史与触发式检索可能把成员 authored 文本带入后续 owner 联网回合；
  system 规则将其视为资料而非指令，但这不是硬信息流隔离。需要更强隔离时应
  另立安全任务，不在本裁决中伪装成已解决。
- 本次 S1 安全复核的原始 PASS 只覆盖私聊路径；群聊路径由集成测试覆盖，
  未做新的独立安全复核。

## 2026-11-08 · 联网搜索默认百度 + 动态当前时间

### 裁决

- `webSearch.engines` 默认 `["baidu"]`，按配置顺序传给 open-websearch；可用
  `baidu/bing/sogou/duckduckgo/exa/brave/startpage/csdn/juejin/linuxdo/hackernews`，
  最多 4 个。原因：Bing 在 request 模式下对中文查询常按单字切词，真实复现中
  “绝区零 2026年11月 最新版本 剧情”返回“绝”字字典词条；同一查询走百度能返回
  官网、版本页和资讯。该改动只影响 ds-memory 的本地配置与搜索请求，不改
  qq-gateway、`docs/CONTRACT.md` 或依赖。
- 每轮在动态用户输入前注入 `【当前时间】YYYY-MM-DD HH:mm（时区）`，使用 Agent
  注入的 `now()` 和运行环境本地时区；只进入模型输入，不进静态 system 段、L0
  或 history。这样“下个月/最新/今天”可以换算，且不破坏静态前缀缓存。
- 静态规则补充：中文搜索使用“具体实体 + 年份/版本 + 关键信息”，结果跑题时换
  一次更具体查询；没有联网工具时不得声称“已搜索/正在搜索/搜索没返回结果”。

### 验证

- 真实 open-websearch 对比：同一中文查询，`engines=["bing"]` 返回单字字典结果；
  `engines=["baidu"]` 返回《绝区零》官网、3.3 版本页及资讯；百度结果 URL 经
  `/fetch-web` 可跟随跳转到官网。
- `npm run typecheck`：0 错误；`npm run contract:check`：26/26。
- `npm test`：51 文件 / 974 通过、1 跳过（Windows 无法创建 symlink）。首跑曾触发
  既有 tinypool teardown `ERR_IPC_CHANNEL_CLOSED`，标准命令复跑通过，无断言失败。

### 残余风险

- 搜索引擎均为网页抓取，HTML 结构、反爬和结果排序会变化；默认百度结果为跳转
  URL，可能夹带广告或旧版本页面，仍依赖模型按标题/年份筛选。
- 当前时间取宿主机时区；若宿主机时区配置错误，模型会得到错误的本地日期。
- 未引入 Playwright；request 模式被目标站点封锁时只能报搜索失败，不会伪造结果。

## 2026-11-08 · 中文搜索准确性与否定结论

### 事故

- owner 在群内询问“下个月米哈游有什么公测游戏”。当时部署仍为
  `engines=["baidu"]`，百度返回安全验证页，模型随后错误回答“2026 年 12 月
  没有已定档公测游戏”，并称《星布谷地》没有具体日期。
- 同一查询走搜狗可返回“米哈游新作《星布谷地》公测定档12月4日”，摘要明确
  写明 `2026年12月4日全球公测`。因此问题同时包含“搜索源失效”和“模型无证据
  否定”两层，不是单纯的 daemon 故障。

### 裁决

- `webSearch.engines` 默认改为 `["baidu", "sogou"]`，按顺序请求；单引擎失败
  时另一引擎仍可返回结果。仍最多 4 个引擎，不新增依赖，不改
  `docs/CONTRACT.md`、qq-gateway 或线上接口。
- 静态规则新增：对“最新/下个月/有没有/是否已定档”类查询，至少使用两个不同
  关键词变体后再下结论；结果出现官网、具体日期或“定档/公测/发布”字样时必须
  优先核对；无法确认时只能表述为“我检索到的结果里没有可靠信息”，不得断言
  “不存在/没有”。
- `web_search` 工具描述同步提示：问“有没有/最新/下个月”时至少换关键词搜两次
  再下否定结论。
- `OpenWebSearchClient` 对多引擎结果按引擎轮转交错，保留各引擎内部的原始排序。
  真实复现中百度 5 条噪声把搜狗首条《星布谷地》定档结果压到第 6 位；轮转后
  两个引擎的首条都会出现在最前面。

### 验证

- 目标测试：`prompt/config/web-client/web-tools/t1-w4-qq-gating` 共 104 项通过。
- 真实搜狗查询返回《星布谷地》定档 2026-12-04 的首条结果；`baidu + sogou`
  联合搜索在百度部分失败时仍保留该结果。

### 残余风险

- 搜狗同样可能触发反爬或排序变化；模型仍可能忽略已返回的正确摘要。多查询
  规则只能降低概率，不能从代码层保证语义判断正确。
- 本次未把搜索结果按日期/官网做程序化加权；是否加权重需先用真实查询集评估，
  避免把权威旧页面误排掉。

## 2026-11-08 · DeepSeek Search API 作为首选搜索源

### 事实与可行性

- 现有 `.env` 中的 `DEEPSEEK_API_KEY` 可直接调用 DeepSeek Search/Fetch API：
  `POST https://api.deepseek.com/v1/tools/search`，Bearer 鉴权，请求体
  `{ query, count, need_content:false }`。真实探测返回 HTTP 200、10 条结果，
  首条为“星布谷地 - 星布谷地”，摘要明确写出 2026-12-04 公测。
- 该接口每次操作只发一次直接请求，不经过辅助模型轮次；DSH 的
  `dsh-web-deepseek-api` 使用同一接口和响应结构。

### 裁决

- 新增 `webSearch.deepseek`，默认 `enabled=false`；本机部署配置设为 `true`。
  启用且 `DEEPSEEK_API_KEY` 存在时，搜索优先直连：
  - Search：`POST {baseUrl}/search`，`count=min(config.count, toolLimit)`，
    `need_content=false`；
  - Fetch 默认不走 DeepSeek：正文仍由本地 open-websearch 抓取，保留既有
    DNS/SSRF 控制；只有未配置本地兜底时才使用 `POST {baseUrl}/fetch`。
- Search 结果映射 `title/url/summary→description/snippet`，以 URL 去重，
  `engine=deepseek`；`summary` 为空才用 `snippet`。结果仍走现有
  `formatWebSearchContent` 的不可信资料框定与字符预算。
- 失败语义：网络错误、超时、HTTP 错误、响应格式错误或凭据缺失回退
  open-websearch；回退成功时 `partialFailures=1`。`web_aborted` 不回退。
- 不新增依赖，不改 qq-gateway、`docs/CONTRACT.md` 或跨项目接口。

### 验证

- 真实 DeepSeek Search API 探测：HTTP 200；首条命中《星布谷地》定档
  2026-12-04。
- 单元测试覆盖请求形状、summary 映射、URL 去重、私网 URL 过滤、缺凭据、
  HTTP 错误、超时、Fetch API、回退与取消不回退、工厂接线。
- `npm run typecheck`：0 错误；`npm test`：52 文件 / 985 通过、1 跳过；
  `npm run contract:check`：26/26；`git diff --check` 无空白错误。
- 真实生产客户端联调：`FallbackWebSearchClient` 返回 10 条结果、
  `partialFailures=0`、`engine=deepseek`；首条为《星布谷地》，第二/三条摘要
  明确包含 2026-12-04 公测。

### 残余风险

- Search API 的配额、计费和可用性由 DeepSeek 侧决定；失败时只能依赖
  open-websearch 兜底，两个源同时失败仍会向模型返回固定错误。
- Search API 的 `summary` 长度可达 1000–2300 字，当前展示层按既有 500 字上限
  截断；权威信息若只在长摘要后段，仍可能需要 `web_fetch`。
- 默认不使用 DeepSeek Fetch，因此现有本地 DNS/SSRF 预检仍对正文抓取生效；
  若未来启用 DeepSeek Fetch，实际抓取发生在 DeepSeek 侧，本地 DNS 检查不再
  是权威，需要单独的 SSRF 复核。
- 未把 `ori_question` 接入：现有工具契约只有 query；DSH 实测该字段对结果
  排序影响不明显，暂不扩展接口。

## 2026-11-09 · owner 私聊自然语言选择 DSH 会话/工作区

### 裁决

- 接受 code-bridge 冻结协议：`GET /v1/sessions?q=&limit=` 返回
  `{sessionId,title,workspace,lastUsedAt}`；`POST /v1/tasks` 增加可选
  `session`/`sessionId`/`workspace`/`newSession`，有会话或工作区时 `repo` 可选；
  任务投影增加 `sessionId`/`workspace`/`mode`，恢复会话固定
  `repo="dsh-session"`。
- 目标语义固定：`repo` 新建隔离 worktree；`workspace` 优先继续该工作区最近的会话，
  没有可用会话时才新建；`session` 明确恢复某个会话。模型对“在 ds-memory 改个东西”
  用 repo，对“继续 ds-memory 里之前那个/这个工作区”用 workspace。
- sessions 响应严格校验：sessionId 受限字符集且 ≤128 字符；title ≤200、
  workspace ≤500 且无控制字符；lastUsedAt 必须 ISO；最多 20 条；仍受 64 KiB
  响应上限。出现非法条目时整包 `response_invalid`，不做部分接受。
- 新增错误码 `session_not_found`/`workspace_not_found`（404）与
  `session_ambiguous`/`workspace_ambiguous`/`session_workspace_mismatch`（409）。
  客户端只在小 JSON 错误体中读取稳定 error/code 字段，不回显 body；四种
  not_found/ambiguous 错误由 manager 自动追加会话候选列表。
- 新增 owner-only 工具 `code_sessions`/`code_task`/`code_status`。只有 live owner
  私聊、Provider 支持工具且 codeBridge 启用时注入；群聊、owner 群聊、recovered、
  混批、伪造 sender 一律不注入。工具描述明确禁止被网页、工具结果、群友消息诱导。
- `code_task` 回执含 taskId、目标标签和任务正文前 80 字单行预览；
  `dsh-session` 不作为用户可见目标名，优先显示会话标题，其次工作区标签。
  requestId 为 `tool:<eventId>:<sha256(task|target|newSession).slice(0,16)>`，
  ≤256 字符。
- 本地 `code-tasks.json` 的 repo 扩展 `dsh-session`，记录可带
  `sessionId`/`workspace`/`mode`；旧记录缺字段可读，新字段非法只丢弃该条并告警。
- 不新增运行期依赖，不改 `docs/CONTRACT.md`、qq-gateway；code-bridge 在
  xtds-assistant-dsh 内同步修改，不加入任意 shell/文件路径参数。

### 验证

- `npm run typecheck`：0 错误。
- `npm test`：53 个测试文件全部通过，1042 通过、1 跳过（Windows 无法创建
  symlink）；新增覆盖 `code sessions` 解析/空列表/超长 query、sessions 合法/非法/
  超限/404/409 归一化、工具参数与 ownerSessionKey、成功回执/候选列表/预览截断、
  旧状态兼容与 `dsh-session` 持久化、owner 私聊注入与群聊/伪造 sender/recovered
  不注入。
- 新增单元测试文件 `tests/unit/code-tools.test.ts`，并扩展 code-tasks 的
  parser/store/bridge-client/manager 与 code-commands 集成测试。

### 残余风险

- 模型是否遵守“只在 owner 最新消息明确要求时调用”属于提示词约束，不是硬保证；
  硬边界仍是 service 注入条件与 manager 来源校验。
- 会话标题/工作区标签由 DSH 侧提供，可能包含误导性文字；已拒绝控制字符、限制
  长度并在展示层折叠绝对路径，但仍需 owner 通过任务预览确认提交内容。
- `code sessions` 单次最多抓取 20 条；“还有 N 个”只反映本次响应剩余量。
- 若 bridge 未返回会话标题，回执只能回退为工作区标签或短会话 id。

## 2026-11-09 · 桌面端预设会话不可 headless 恢复

### 裁决

- DSH `0.2.2-rc.1` 的 headless 一次性运行器拒绝恢复带非空 `agentPreset` 的
  会话；「小助手」属于桌面端 `standard` 预设，因此不再视为普通代码任务失败。
- code-bridge 的 `/v1/sessions` 增加 `resumable`。无预设会话为 `true`，
  带命名预设的会话为 `false`；显式恢复后者在启动 DSH 前返回
  `409 session_preset_incompatible`。
- `workspace` 查询只优先恢复 `resumable=true` 的会话；若该工作区只有不可恢复
  会话，则回退为新建会话/worktree。`session` 明确指定不可恢复会话时直接拒绝。
- ds-memory 在会话列表标注“不可恢复（桌面端预设）”，任务失败与终态通知给出
  可读原因，并提示改用 `workspace + newSession: true` 或其他会话。
- 继续在「小助手」原上下文工作的唯一方式是 DSH 桌面端；QQ 代码任务不能绕过
  headless 的预设限制。

### 验证

- code-bridge `npm run check`：19 个文件通过；
  `node --test test/sessions.test.js`：14/14；`test/security.test.js`：11/11。
- ds-memory `npm run typecheck`：0 错误；code-tasks、code-tools 与 prompt
  定向测试 4 文件 / 139 测试通过。
- 临时真实 bridge 实例确认「小助手」返回 `resumable=false`，对其提交返回
  `409 session_preset_incompatible` 且未启动 DSH；生产 code-bridge 已重启。
- 生产 ds-memory 已通过 supervisor 重启，`http://127.0.0.1:985/health`
  返回 healthy。

### 残余风险

- code-bridge 的 Windows 进程树终止测试在 Codex 沙箱下有两项超时；现场判断为
  `taskkill` 清理环境限制，需在非沙箱环境复跑确认。
- 生产 supervisor 状态中的 `online` 仍只反映进程健康，不直接代表 SnowLuma
  会话可用；QQ 实测仍是最终验收依据。

## 2026-11-09 · owner 群聊 @ 显式 code 命令

### 事实与问题

- 群 `10002` 中 owner 发送 `code` 与“我们DSH代码会话有什么”均正常到达并回复，
  但模型回合没有 `code_sessions`/`code_task`/`code_status`，因为代码工具按既有裁决
  只注入 owner 私聊。
- `code` 控制消息在 hook 层只对 owner 私聊完成解析；群聊消息因此被当成普通文本，
  模型只能表示“本轮没有代码工具”。网关与发送链路正常，不是消息丢失或管理员识别失败。

### 裁决

- 扩展 `code` 控制命令来源：owner 私聊，或 `qq.allowGroups` 内且不在
  `qq.denyGroups` 内的群，由 owner 本人 `@`/引用机器人（`isAtBot === true`）触发。
- 群聊仍只支持显式控制命令：`code sessions [关键词]`、`code status`、
  `code cancel <taskId>`、`code <repo> <task>`、多行 `code <repo>\n<task>`。
  不向群聊模型回合注入 `code_sessions`/`code_task`/`code_status`，也不开放群聊自然语言
  选择会话；自然语言代码工具仍只属于 owner 私聊。
- 普通群友、陌生私聊、owner 未 `@`、非白名单群、`denyGroups`、recovered/混批一律
  不执行命令、不访问 bridge；服务层静默丢弃，避免绕过普通成员回复限流。
- 群聊命令回执发回原群；终态通知仍只发 owner 私聊。命令仍不写 L0/Receipt、不调用模型；
  `requestId` 继续使用 eventId，重复事件由 manager 幂等处理。
- 不修改 `docs/CONTRACT.md`、qq-gateway 线上接口、依赖或 `package.json`。

### 验证

- `npm run typecheck`：0 错误。
- `npm test`：53 文件 / 1053 通过、1 跳过；`npm run contract:check`：26/26。
- `npx vitest run tests/unit/code-tasks-manager.test.ts tests/integration/code-commands.test.ts`：
  2 文件 / 56 测试通过。
- 覆盖 owner 群 `@` 提交、`code sessions` 查询、普通群友 `@` 与 owner 未 `@` 静默丢弃、
  owner 私聊回归、群聊不注入模型代码工具。

### 残余风险

- 群聊命令仍是关键词控制面，owner 必须使用 `code` 明确前缀；单独说“看看代码会话”不会
  触发。这样保留可审计边界，避免群内自然语言/引用诱导扩大代码工具攻击面。
- 群聊命令回执绕过普通成员回复限流，但只对 owner 生效；若未来扩大触发人范围，需重新评审。

## 2026-11-09 · 修复 QQ @ 前导空格吞掉 code 命令

### 事实

- 群 `10002` 的 owner `@` 消息在网关正常 `report.acked`，L0 原文为
  ` text: " code"`、`isAtBot: true`。
- OneBot 把 `@` 消息段与后续文本段分开，文本段带一个前导空格；旧 hook
  只接受索引 0 的 `code`，因此消息被当成普通文本交给模型，模型回复“本轮没有代码工具”。
- 这不是网关丢消息，也不是管理员识别失败；SnowLuma 的 hook 握手超时日志之后仍有
  消息正常到达和回复。

### 裁决

- 只对 `source.kind === 'group' && isAtBot === true` 的命令候选剥离开头的
  空格、制表符或换行，再执行严格 `code` 识别。
- 私聊 `" code"`、群内未 `@` 的 `" code"`、普通群友、非白名单群仍保持普通消息或静默丢弃；
  不修改 `docs/CONTRACT.md`、qq-gateway 线上接口或 L0 原文。
- hook 仍先做 deny/权限判定，再短路 code；黑名单 403 优先级不变。

### 验证

- hook 回归覆盖群 `@` + `" code sessions"`：回调触发，L0/Receipt/会话均不写入。
- manager 回归覆盖群 owner `@` + 前导空格提交；私聊前置空格仍由 parser 测试保持普通消息。
- `npm run typecheck`：0 错误；定向 2 文件 / 57 测试通过。
- 全量测试：53 文件 / 1054 通过、1 跳过；`contract:check`：26/26。
- 生产 `ds-memory` 已通过 supervisor 重启，PID 37228，`127.0.0.1:985/health` 正常。

## 2026-11-09 · 人格卡生效与旧自认知归档

### 事实

- `state/persona` 原先只有 `nickname.txt=大肥鱼`，没有 `card.md`；项目根也没有
  `persona.md`，实际基础人设仍是内置的「小鲸鱼」。
- 私聊 selfNote 中仍有多条互相冲突的旧记录：「我是小鲸鱼」「不接受大肥鱼」
  「不能主动联网」「只能处理文字」；这些记录排在人格卡之后注入，会抵消 owner 的称呼设定。
- 群聊最近连续拒绝 owner 的「说 hmy 不懂 AI」，属于模型对具体对象贬损的内容边界，
  不是网关丢消息；owner 身份只授予指令权限，不等于绕过模型安全边界。

### 裁决

- 新建 `state/persona/card.md`：定义「大肥鱼」身份；owner 私聊或群聊 `[管理员]`
  的合法、无害指令默认执行；允许对 owner 明确说明的宠物、虚构角色做轻度玩笑；
  继续拒绝真实第三方贬损、凭据、违法、危险和不可逆破坏操作。
- 归档 7 条明确的过期/冲突 selfNote，仅追加 `archived:true`，不删除原文；
  备份在 `_backups/selfnotes-persona-fix-20261109-2125`。
- 不改代码、不改 `docs/CONTRACT.md`、不改群权限或 owner 识别。

### 验证

- `PersonaCardStore.promptText()` 已包含新人格卡与「大肥鱼」称呼。
- `SelfNoteStore.bootstrapText('private:10001')` 不再包含旧身份、旧称拒绝或
  「不能联网/只能处理文字」的过期自认知。
- `ds-memory` 已通过 supervisor 重启，`127.0.0.1:985/health` 正常。

### 追加边界（2026-11-09 21:37 实测）

- 人格卡生效后，她已接受「大肥鱼」称呼，但仍拒绝按 owner 要求复述
  「hmy 不懂 AI」；她明确表示这是对具体对象的贬评，不由称呼或 owner 权限改变。
- 裁决：不实现“owner 可无条件强制侮辱/贬损任何对象”的绕过层。人格卡只覆盖
  称呼、语气、合法任务和宠物/虚构角色的轻度玩笑；真实第三方贬损、隐私攻击、
  凭据、违法和不可逆破坏仍由模型安全边界拒绝。
- 若后续出现“无害任务也不执行”，应单独查工具注入、群聊命令路由和 owner 身份，
  不能把内容拒答误判为执行链路故障。

## 2026-11-09 · 管理界面以 DSH 面板为准，P4 网页 UI 不实施

### 事实

- 当前日常操作已经通过 `xtds-assistant-dsh` 的 DSH 插件完成：服务状态、启动/停止/重启、
  SnowLuma 端口、code-bridge 和 open-websearch 都在同一面板中可见。
- ds-memory 路线图中的 P4 仍列有“网页 UI”，但该界面会与 DSH 面板形成第二套管理入口。

### 裁决

- owner 明确不需要脱离 DSH 面板独立管理；P4 网页 UI 不实施。
- 管理入口维持单一来源：DSH 插件负责进程与运行状态，ds-memory 继续负责记忆、人格、
  资料库、联网与 QQ 脑侧；不新增独立 Web 控制台。
- 不影响资料库等已有能力；P4 中“owner 本机工具”如未来有明确需求，单独提案，不随网页 UI
  自动恢复。

### 验证

- 本次裁决不改变运行时代码、接口或配置，无需新增测试；现有 QQ + DSH 闭环保持为验收基线。
