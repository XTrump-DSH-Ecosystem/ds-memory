# 实现交接提示词 · P1.1 补丁 + P2 脑侧（给 Flash 模型）

> 项目路径：`E:\workspace\ds-memory`。P1 已评审通过（1 个必改小项）。
> 开工前必读：`docs/ARCHITECTURE.md`、`docs/CONTRACT.md`（接口契约 v1，权威）。
> **本简报只管脑侧**；网关侧是另一个仓库的另一份简报，不要在这里实现任何 OneBot/SnowLuma 代码。

## 一、P1.1 补丁（先做，10 分钟内）

1. 检索注入的说话人标签反了。`src/memory/retriever/bigram.ts` 的 `addDoc`：
   - 现在：`who: record.role === 'user' ? '我' : '你'` —— **反了**
   - 模型读【回忆】块时：「你」= 用户说过的话，`「我」` = 模型自己以前的回复
   - 改：`who: record.role === 'user' ? '你' : '我'`
   - 同步改 `src/memory/retriever/types.ts` 第 8 行注释（user → 你，assistant → 我）
   - 补断言：mock L0 里放 user/assistant 各一条 → search → `formatInjection` 输出含 `你：` 与 `我：` 且归属正确
2. 提交 commit（不在本次大 P2 里混着提交，单独一个小提交，消息形如 `fix: 检索注入说话人标签 user/assistant 反了`）

## 二、P2 脑侧范围（QQ 线，只做「脑」部分）

### 1. 配置扩展 `src/config/load.ts`

新增（沿用现有默认值收敛风格，全部进 zod）：

```jsonc
"qq": {
  "enabled": false,                 // P2 默认关：CLI 不受影响
  "hookPort": 4100,
  "hookToken": "",                  // 与网关共享的 token（CONTRACT §1）
  "gatewayUrl": "http://127.0.0.1:4200",
  "ownerQQ": 0,
  "allowGroups": [],
  "denyPrivate": [], "denyGroups": [],
  "batchWindowMs": 2000,            // 合批窗口（收到消息后等多久再投给 Agent）
  "send": { "maxPerTurn": 3 }
}
```

注意 `qq.ownerQQ` 已是 number（P0 形状），其余按需扩充；**保留旧字段默认值不破坏 CLI**。

### 2. QQ 薄客户端 `src/qq/client.ts`

- `QqClient.send(target, messages, opts)` → 按 CONTRACT §3 POST `/send`，带 `X-Memory-Token`
- 429 → 读 `X-Retry-After-Ms`，最多重试 2 次（2s/10s 间隔），仍失败返回失败原因
- `QqClient.health()` → 按 CONTRACT §4 探测网关，结果进 `/status` 与日志
- 全量走 `redact()`；不引入 axios——用内置 fetch

### 3. Hook 服务 `src/qq/hooks.ts` + `src/qq/session-map.ts`

- HTTP 服务挂在 `hookPort`：`POST /hook/message`、`GET /health`（CONTRACT §2/§4，token 校验 401、形状校验 400、黑名单 403）
- 会话映射：`private:<qqId>` / `group:<id>`（CONTRACT §5）；映射持久化 `state/qq-sessions.json`（重启可查，字段人类可读）
- 权限判定（严格按 CONTRACT §5 顺序）：黑名单 > owner（`private:<ownerQQ>`）> allowGroups > 不响应。**不响应的消息不建会话、不落 L0、不唤醒**（记忆卫生：陌生私聊不烧 token）

### 4. 合批与节奏 `src/qq/inbox.ts`

- 每会话一个收件箱：`batchWindowMs` 内到达的消息合并成一次投递（超时按 first-message + window 计）
- 会话忙 → 排队，本轮结束补投（沿用 P0/P1 的「忙」判定思路，简化版：Agent.runTurn 进行中即忙）
- 拍一拍/引用按 CONTRACT 的 `poke`/`quote`/`isAtBot` 字段原样透传（文本直接可用；`quote` 拼成 `[引用 张三：原文]` 前缀，抄 fork 的久经验证的格式）
- `media` 数组 P2 一律空——收到非空就先只保留文本并记日志（不要实现图片）

### 5. Agent 多会话与回复 `src/agent/`、`src/main.ts`

- 每个 sessionKey 一个 Agent 实例（Map 持有；memory 层本就按会话隔离，facts/selfNote/retriever 已支持）
- 回复走 `QqClient.send`；`replyToMessageId` 只在「引用回复」场景带
- 单轮多句按 `send.maxPerTurn` 截断；其余纪律与 CLI 一致（先落 L0 再推理、静态段纪律不动）
- `/status` 增加：hook 端口、网关健康、会话数、权限结果计数

### 6. 常驻形态

- `npm run serve` = `node src/main.ts --serve`：起 hook 服务 + 轮询网关健康，不再进 CLI readline；CLI 模式（原 `npm run dev`）保持不变
- 单实例锁（复查 P0 有没有？若没有，用 `state/lock.json` 简易实现，防重复起进程）

### 7. 测试（新断言 ≥ 10 条）

- 契约 fixture：建 `tests/contract/`，用 CONTRACT §6 的合法/非法/超大/缺字段消息打 `/hook/message`，断言 200/400/401/403 与权限顺序
- 合批：窗口内 3 条合成一次投递；窗口外第二条是新回合
- 会话隔离：两个私聊互不串 facts/检索（复用现有 store 语义即可，断言 key 不同）
- 发送失败放弃：mock 网关 500×3 → 脑侧日志放弃、Agent 本轮正常收尾（不崩）
- 回复携带引用 ID 的场景

### 8. 出口条件

- tsc 零错误；`npm test` 全绿（75 + 新增）；依赖仍 ≤ 5（fetch 够用，零新增）
- 手工验收：起一个 `node` 假网关（或直接 curl 打 hook），验证「消息进 → 合批 → Agent 回复经 /send 发出」全链路；`/status` 可见网关健康与会话数
- 无网关侧实现混入（OneBot/ws/SnowLuma 一个字符都别写）

## 三、跑偏警告

1. **别在脑侧写 OneBot**：协议在网关。脑只认 CONTRACT 的 JSON
2. 别把合批窗口的等待做成阻塞 EventLoop 或影响 CLI 模式
3. 权限判定结果要进日志（谁被拒、为什么），这是排障刚需
4. 陌生私聊（非 owner/非白名单）绝不建会话落盘——白嫖 token 的入口
5. `media/poke` 只透传不解构，图片识别不是本阶段的事

## 四、完成后

回执给规划侧：tsc/test 输出、手工全链路记录、新增配置项说明。通过后解冻网关侧联调（另一仓库）。