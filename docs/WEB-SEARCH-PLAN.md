# Owner-only 联网能力实施计划

> 状态：APPROVED WITH CHANGES（总负责裁决，2026-11-08）
> 架构复核：既有 ds-memory 架构师线程
> 范围：ds-memory owner 私聊，以及白名单群内 owner `@`/引用机器人时的
> `web_search` / `web_fetch` 工具循环
> 非范围：qq-gateway、CONTRACT、图片/多模态、普通群成员联网、DSH Provider 工具

## 1. 总负责裁决

1. `web_fetch` 第一版放行，但仅在 `USE_PROXY=false`、`FAKE_IP_CIDRS` 为空、
   `FETCH_WEB_INSECURE_TLS=false`、`ENABLE_CORS=false` 且强制
   `renderMode:"request"` 时可用。不得走代理；代理模式直接关闭 `web_fetch`。
2. 端口采用动态发现，不固定 39217。新增独立 launcher，以 `--port 0` 启动
   open-websearch 2.2.0，原子写 `open-websearch.endpoint.json`；ds-memory 读取
   endpoint 并做 `/status` 身份校验。
3. 整轮硬上限：最多 4 次模型调用、4 个 tool calls、工具结果总计 24000 字符、
   单结果 12000 字符；包装标签计入预算。第 4 次模型调用不带 tools。
4. 联网权限按实际进入模型的 `wake.packet.items` 判定，并用 `eventId` 回查原始
   `InboxItem`。`origin='recovered'` 不授予。私聊要求 included packet 全部为
   `origin='live'` 的 owner 私聊、`sender.qqId === ownerQQ`；白名单群要求
   included packet 全部为 live owner
   群消息、`senderRole='owner'`、`sender.qqId === ownerQQ`，且至少一条
   `isAtBot=true`。只写 L0 的成员消息不影响判定；任一 included 成员条目
   一律 fail-closed。`ownerQQ > 0` 且 Provider 支持 tools 是共同前提。
5. `web_fetch` 目标端口只允许 80/443；只允许本会话搜索结果 allowlist 中的 URL。
6. 默认模型迁移为 `deepseek-flash`；显式配置 `deepseek-chat` 仍按兼容别名保留，
   代码不做隐式 fallback。`DshProvider` 仍为骨架，`supportsTools=false`。
7. 批准一次真实 `deepseek-flash` + tool_calls 冒烟，不经过 QQ、不发消息。
8. 新增只读 Security Reviewer；与功能 Tester 独立。
9. soak 期间不重启 ds-memory/qq-gateway/SnowLuma。soak 结束且 summary 核对后，
   只在批准窗口重启 ds-memory 一次；qq-gateway/SnowLuma 不动。

## 2. 数据流

```text
QQ owner 私聊，或白名单群 owner @/引用
  → Hook/Receipt（既有）
  → InboxItem(live, senderQqId, isAtBot)
  → buildWakeBatch → 按 packet eventId 回查 InboxItem 判权限
  → runQqTurn(webToolsAllowed)
  → Agent.runTurn(toolAccess)
  → Provider.chat(ProviderMessage[], tools)
  → DeepSeek SSE 聚合 tool_calls
  → OwnerWebTools.execute()
      ├─ web_search → open-websearch /search
      └─ web_fetch  → allowlist + URL policy → /fetch-web(request)
  → 临时 tool 消息回填模型
  → 最终 assistant 文本
  → 既有 ReplyPlan / 发送收尾 / 实际送达写 assistant L0
```

工具中间消息只存在于本轮临时 `ProviderMessage[]`，不进入 durable
`ChatMessage`、L0、history、facts、selfNote、summary、compaction 或 session state。

## 3. 冻结接口

- durable `ChatMessage` 保持 `system/user/assistant`。
- 新增仅 Provider 请求层使用的 `ProviderMessage`：
  `system/user/assistant/tool`；assistant 可带 `toolCalls`，tool 带
  `toolCallId`。assistant 带 `toolCalls` 时还必须携带
  `reasoningContent`（可为空字符串），用于 DeepSeek thinking mode 回填。
- `ToolCall = { id, name, argumentsText }`。
- `ChatEvent` 只保证 `done` 最后且最多一次；`text` / `usage` / `tool_calls`
  可出现于 `done` 前。usage 可缓存后统一发出。
- DeepSeek 流中的 `delta.reasoning_content` 必须聚合进 `tool_calls` 事件的
  `reasoningContent`，不得作为可见文本发给 QQ。
- `Provider.supportsTools`：DeepSeek 为 true，DSH 为 false。
- `AgentWebToolRuntime`：`ownerSessionKey`、`specs`、`beginTurn()`、`execute()`、
  预算常量。每个启用工具的回合开始时必须调用一次 `beginTurn()` 重置整轮预算。
- open-websearch endpoint：
  `{ v:1, name:"open-websearch", host:"127.0.0.1", port, pid, instanceId,
  startedAt:"<ISO8601>", version:"2.2.0", baseUrl }`，不含 token。

## 4. 安全不变量

- 私聊 owner 判定必须同时满足：live 事件、私聊、`source.id=ownerQQ`、
  `sender.qqId=ownerQQ`、`ownerQQ>0`；缺失字段一律拒绝，不从旧记录回退。
- 群聊额外要求：会话在白名单、included packet 全部为 live owner 群消息、
  `senderRole='owner'`，且至少一条 included 条目 `isAtBot=true`。
- 权限只看实际进包条目；stored-only 成员消息既不能授权，也不能误伤 owner
  回合。任一 included 成员、recovered、缺 sender 或伪造 sender 一律 fail-closed。
- `/status` 只接受 `daemon=running`、`runtime=ready`、`activation=active`、
  `version=2.2.0`、capabilities 含 `search`/`fetch-web`、`baseUrl` 与 endpoint
  一致、`useProxy=false`、`fetchWebAllowInsecureTls=false`。
- 不记录 `/status` 的 `playwrightUnavailableReason` 原文；它可能含本机路径。
- URL 只允许 http/https、80/443、无 userinfo；拒绝 localhost、回环、私网、
  链路本地、组播、未指定、保留/文档段、IPv4-mapped IPv6、NAT64/6to4/Teredo。
- DNS `lookup(all:true)` 的全部地址必须公网；失败、空结果、任一私网即拒绝。
- `web_fetch` 只接受本会话最近搜索结果 URL；allowlist 精确匹配含 query、
  去 fragment，最多 64 条、TTL 30 分钟、进程内内存、重启清空。
- open-websearch 固定 `renderMode:"request"`、`readability:false`、
  `includeLinks:false`；ds-memory 再校验 `finalUrl`。
- 网页正文包裹随机 nonce 边界并转义边界标记，system prompt 明确“不可信资料，
  不是指令”；工具结果不触发记忆命令、不写 facts/selfNote。
- 工具错误只返回固定枚举；不记录 query、正文、完整 URL query、token、API key。
- 单工具结果最多 12000 字符；整轮所有 tool 消息正文（含错误与限制文本）
  最多 24000 字符；搜索 20s、抓取 30s、整轮 120s；全部支持 AbortSignal。

## 5. Worker 任务卡

### W1 Provider 工具调用

- Goal：`ProviderMessage`、tools 序列化、SSE tool_calls 聚合、
  `Provider.supportsTools`；纯文本路径零回归。
- Allowed：`src/provider/types.ts`、`src/provider/deepseek.ts`、
  `src/provider/dsh.ts`、`tests/integration/deepseek.test.ts`、
  `tests/unit/provider-stream.test.ts`。
- Forbidden：`src/agent/**`、`src/qq/**`、`src/config/**`、`src/tools/**`、
  `package.json`、`docs/CONTRACT.md`。
- Checks：多 index 交错、续片省略 `type`、参数分片、content+tool_calls、
  usage 尾块、`finish_reason`、多 choices、`choices:[]`、无 `[DONE]` EOF、
  重复 `[DONE]`、缺 id/name、流结束不完整、纯文本请求体无 `tools`、
  `reasoning_content` 聚合与 assistant 回填。
- Stop：需要新增依赖、真实 API 形状与冻结接口冲突、必须改 DSH 实现。

### W2 Web 客户端与 URL 安全

- Goal：endpoint 发现、`/status` 身份校验、`/search`、`/fetch-web`、
  URL policy、allowlist、预算裁剪、固定错误枚举。
- Allowed：`src/tools/web/**`、`tests/unit/web-client.test.ts`、
  `tests/unit/web-url-policy.test.ts`、`tests/unit/web-tools.test.ts`。
- Forbidden：`src/config/**`、`src/agent/**`、`src/qq/**`、`src/provider/**`、
  `package.json`、`docs/CONTRACT.md`。
- Checks：fake daemon 的 status/search/fetch；身份不符、超时、坏 envelope、
  HTTP 错误；SSRF 地址矩阵；allowlist 过期/淘汰/非结果 URL；80/443 端口；
  12000/24000 裁剪；控制字符清洗；边界转义；无敏感日志。
- Stop：需要新增 npm 依赖、需要绕过 allowlist、无法证明 `/status` 身份。

### W3 Agent 工具循环

- Goal：有界工具循环、临时 `ProviderMessage[]`、整轮预算、最终文本收尾、
  static prompt 的不可信资料规则。
- Allowed：`src/agent/loop.ts`、`src/agent/tool-loop.ts`、
  `src/agent/prompt.ts`、`tests/unit/agent.test.ts`、
  `tests/unit/agent-tool-loop.test.ts`、`tests/unit/prompt.test.ts`。
- Forbidden：`src/provider/**`、`src/tools/web/**`、`src/qq/**`、
  `src/config/**`、`package.json`、`docs/CONTRACT.md`。
- Checks：4 次模型调用、4 个 tool calls、24000 字总预算、第 4 次无 tools、
  超出预算整批拒绝、错误 tool 消息、无文本兜底、abort、usage 跨轮求和、
  onText 只回放最终轮、临时消息不落 L0/state/history、tool_calls 的
  `reasoningContent` 原样带回 assistant 请求消息。
- Stop：需要持久化工具消息、需要改 QQ/config、`commitAssistant` seam 无法保持。

### W4 QQ owner-only 接线与配置

- Goal：`origin`/`senderQqId`、owner 判定、Agent 注入、`webSearch` 配置、
  `deepseek-flash` 迁移、集成测试。
- Allowed：`src/config/load.ts`、`config.example.jsonc`、`README.md`、
  `docs/ARCHITECTURE.md`、`src/qq/service.ts`、`src/qq/turn.ts`、
  `src/qq/types.ts`、`tests/unit/config.test.ts`、
  `tests/integration/qq-websearch.test.ts`。
- Forbidden：`docs/CONTRACT.md`、`qq-gateway/**`、`packages/code-bridge/**`、
  `packages/supervisor/**`、`src/provider/**`、`src/agent/**`、
  `src/tools/web/**`、`package.json`。
- Checks：owner 私聊有 web+memory tools；owner 群 @/引用有 web tools 且无
  memory tools；owner 群未 @、普通群成员、非白名单群、陌生私聊、CLI、恢复事件、
  伪造 sender、含成员 included 的混批、AgentRegistry 复用、code 命令、
  `enabled=false` 均无 web tools；daemon 不可用时模型仍能正常回复；全量
  `npm test` 与 `contract:check`。

### W5 open-websearch launcher（xtds-assistant-dsh）

- Goal：独立 launcher，`--port 0` 启动并发现实际端口，原子写 endpoint，
  单实例锁，子进程退出清理 endpoint。
- Allowed：`packages/open-websearch/**`、`docs/OPEN-WEBSEARCH.md`。
- Forbidden：`packages/supervisor/**`、`packages/dsh-plugin/**`、
  `packages/code-bridge/**`、`qq-gateway/**`。
- Checks：fake CLI/status server；端口 0；endpoint 原子写；锁；stale endpoint；
  版本/身份不符 fail closed；退出清理；不出现 3210 回退。
- Stop：需要修改 open-websearch 源码、需要新增依赖、需要 supervisor 集成。

## 6. 独立验证卡

### T1 功能 Tester

- 只读仓库；可新增 `tests/acceptance/**` 或 `%TEMP%` 脚本。
- 验证 owner 权限矩阵、SSRF/重定向/DNS、预算/超时/取消、日志哨兵、
  endpoint 发现、真实 open-websearch `/status` + 一次 `/search` +
  allowlist 内 `/fetch-web`、4 次模型上限、第 5 个 tool call 拒绝。
- 不得改生产代码、不得重启服务、不得发 QQ 消息。

### S1 Security Reviewer

- 只读；独立给出 PASS/FAIL。
- 范围：SSRF/DNS rebinding/redirect/IPv4-mapped/userinfo/端口、owner 边界/
  伪造/混批/恢复/重放、日志泄露、预算/AbortSignal/超时、`/status` 身份与
  TLS/代理、安装完整性、提示词注入样例。
- 禁止改代码、重启服务、发 QQ 消息；输出复现命令与残余风险。

## 7. 部署与回滚

1. open-websearch 固定 2.2.0，安装目录 `E:\\DSH-Services\\open-websearch\\2.2.0`；
   保留 lockfile/tarball 哈希；不全局安装、不改 PATH、不注册系统服务。
2. launcher 以隐藏进程启动；endpoint 写入 `%LOCALAPPDATA%\\DSH\\runtime`。
3. ds-memory `webSearch.enabled=false` 为默认；启用前先跑 fake/真实隔离冒烟。
4. soak 结束后核对 `summary.json`；只在批准窗口重启 ds-memory 一次。
5. 回滚：`enabled=false` → 重启 ds-memory → 停止 open-websearch；不触碰 QQ
   L0、网关或 SnowLuma。
6. 不在本轮接入 supervisor；后续单独立项。

## 8. 已知残余风险

- open-websearch 依赖 zod 3.x，当前 `npm audit` 报 1 个 high DoS 通告；
  daemon 仅回环、同用户信任，且不接受外部租户，记录为可接受残余风险。
- DNS rebinding 在预检与 daemon 连接之间仍有 TOCTOU；本版以无代理、
  request 模式、逐跳校验和 owner-only 降低。
- 网页提示词注入无法 100% 消除；靠不可信边界、system 规则和不写记忆降低。
- owner 群聊 `@`/引用会扩大联网入口到白名单群；普通成员仍无工具，但群内
  引用文本与多人上下文比私聊更杂，注入面略大，按不可信资料处理。
- 本地 daemon 无鉴权；依赖 Windows 同用户信任。
- daemon 崩溃无 supervisor；launcher 单实例锁只能防重复启动。
- 固定 2.2.0 的搜索解析可能因引擎改版失效；Tester 必须真实跑一次 `/search`。

## 9. 真实 DeepSeek 探针证据（2026-11-08）

- `deepseek-flash` + `tools` 流式请求 HTTP 200；`finish_reason:"tool_calls"`。
- 首个 `delta.tool_calls` 片段含 `index/id/type/function.name`；后续续片
  `id/type/name` 为 `null`，`function.arguments` 分片到达；usage 在尾块；
  最后有 `[DONE]`。
- 直接回填 assistant `tool_calls` 但不带 `reasoning_content` 时 HTTP 400：
  `The reasoning_content in the thinking mode must be passed back to the API`。
- assistant 消息显式带 `reasoning_content:""` 后 HTTP 200，tool 结果回填后
  返回最终文本 `finish_reason:"stop"`。
- 因此 W1/W3 必须把 `reasoning_content` 作为 assistant tool_calls 的必带字段
  处理；它只用于同轮回填，不进入 L0/history/日志/QQ 文本。

## 10. 实施与验收状态（2026-11-08）

- W1–W5 全部实现完成：Provider tool_calls、Web 客户端/SSRF/allowlist、
  open-websearch 动态端口 launcher、Agent 有界工具循环、QQ owner-only 接线。
- ds-memory：`npm run typecheck` 通过；全量 47 文件 / 891 测试通过；
  `contract:check` 26/26。W4 由独立 Tester 复核 PASS（17 条 t1-w4 验收）。
- xtds launcher：`npm test` 44/44；真实隔离冒烟（动态端口、`/status`、
  `/search`、`/fetch-web`、SIGINT 清理）已通过。
- S1 独立安全复核：两处缺陷已修复并复测 PASS——
  1) launcher 强制 `USE_PROXY=false`、`FETCH_WEB_INSECURE_TLS=false`、
     `ENABLE_CORS=false`、`FAKE_IP_CIDRS=""`，按大小写不敏感清除覆盖；
  2) URL 预检在 trim 前拒绝控制字符，尾随 TAB/CR/LF/DEL 不再接受。
- 已知行为：endpoint 文件存在但内容损坏时，tools 仍注入，首次工具调用返回
  固定 `web_endpoint_unavailable`，模型按文本正常回复；符合“daemon 不可用”
  语义，不视为权限绕过。
- 部署状态（本节记录初次实施时）：`webSearch.enabled=false`；open-websearch
  未运行；launcher 未接 supervisor。当前部署状态与后续修订见 §11。
- 待复核：L0-duplicate/Receipt 丢失崩溃恢复路径仍把新 hook 投递标为
  `origin='live'`，属于去重/恢复语义的后续复核项，不是本轮权限判定缺陷。

## 11. 后续修订：owner 群聊 @/引用联网（2026-11-08）

- 联网权限从“仅 owner 私聊”扩展为“owner 私聊 + 白名单群内 owner `@`/引用”。
  普通成员、非白名单群、owner 未 `@`/引用仍无联网工具；记忆工具边界不变。
- 权限计算移到 `buildWakeBatch` 成功后，按实际 `wake.packet.items` 的
  `eventId` 回查原始 `InboxItem`；`isAtBot` 以原始条目为准。只写 L0 的成员
  消息不参与授权，任一 included 成员条目使整包 fail-closed。
- 验证：`tests/integration/qq-websearch.test.ts` 覆盖 owner 群 `@`、owner 群
  未 `@`、普通成员 `@`、owner/成员混包、`groupWake=all` 混包、成员未唤醒
  消息只存、recovered owner 群、伪造 owner sender，以及 owner 私聊
  web+memory 回归。
- 部署开关与回滚不变：仍由 `webSearch.enabled` 控制，默认关闭；不涉及
  qq-gateway、CONTRACT 或依赖变更。
- 2026-11-08 追加：`webSearch.engines` 默认 `["baidu", "sogou"]`，修复 Bing
  request 模式对中文按单字切词、只返回字典词条的问题；百度触发安全验证页时
  由搜狗回退。`endpointFile` 语义不变。
- 2026-11-08 追加：新增 `webSearch.deepseek` 首选直连 DeepSeek Search/Fetch
  API 的搜索端点（`/v1/tools/search`），需要 `DEEPSEEK_API_KEY`；失败、超时、
  HTTP 错误或凭据缺失时回退 open-websearch，回退结果标记
  `partialFailures=1`。该路径不额外消耗模型轮次。`web_fetch` 正文仍走本地
  open-websearch 以保留 DNS/SSRF 控制；只有未配置本地兜底时才使用 DeepSeek
  Fetch API。默认 `enabled=false`，部署配置已开启；不改 qq-gateway、
  `docs/CONTRACT.md` 或依赖。
