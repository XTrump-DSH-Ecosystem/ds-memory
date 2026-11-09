# 实现交接提示词 · qq-gateway 建仓与 P1（给 Flash 模型）

> 新项目：**qq-gateway**（独立仓库、独立进程、薄网关）。
> 开工前必读：本文件 + 从 `ds-memory/docs/CONTRACT.md` 复制过来的契约（**契约是权威，逐字段对齐**）。
> 你只做 QQ 传输；脑侧（ds-memory）由另一个会话负责，两边用契约测试对齐，不允许私下"顺手"改契约。

## 一、项目定位

```
QQ ── SnowLuma(OneBot v11 WS 3001 / HTTP 3000) ── qq-gateway（本仓库）──HTTP 回环── ds-memory（脑）
```

- 职责：OneBot 连接与 token 自愈、QQ 事件转 CONTRACT 消息上报、发消息 + 发信限流（QQ 风控）、健康检查
- 非职责（红线）：没有任何 AI/记忆/权限/内容过滤逻辑；不会话管理；不对消息做"要不要发给脑"的判断（黑名单由脑 403 告知）

## 二、建仓要求

1. TypeScript strict（tsconfig 与 ds-memory 同款纪律：strict、noUncheckedIndexedAccess、erasableSyntaxOnly、NodeNext、.ts 导入扩展名）
2. Node ≥ 24；测试 vitest；`npm install` 后提交 package-lock
3. 依赖 ≤ 5：`ws`（OneBot 反向 WS 必需）、`zod`；其余用内置。**不引** OneBot SDK 全家桶（手写几十行协议比背一个黑盒可维护）
4. `.gitignore`（node_modules/、state/、.env、config.jsonc、*.log）；config 采用与 ds-memory 同款的 jsonc 注释剥离+zod 收敛（那段 stripComments 可抄，MIT 自家代码）
5. 目录建议：`src/{config,onebot,httpd,send,util}/` + `tests/`

## 三、P1 范围清单

### 1. 配置

```jsonc
{
  "snowluma": {
    "wsUrl": "ws://127.0.0.1:3001",
    "httpUrl": "http://127.0.0.1:3000",
    "accessToken": "",       // 留空走自愈发现
    "homeDir": "D:\\SnowLuma" // 自愈要读的安装目录（onebot_<QQ>.json 里取 token/端口）
  },
  "mind": {                   // 「脑」的地址
    "hookUrl": "http://127.0.0.1:4100/hook/message",
    "token": "",             // 与脑共享（CONTRACT §1）
    "healthUrl": "http://127.0.0.1:4100/health"
  },
  "send": { "maxPerMinute": 6, "maxPerHour": 60, "minIntervalMs": 800 },
  "port": 4200,              // 本进程 /send 与 /health 监听端口
  "stateDir": "./state"
}
```

### 2. OneBot 连接 `src/onebot/`

- WS 客户端（`ws` 库）连 `wsUrl`，带 `Authorization: Bearer <token>`；`meta_event` 心跳保活与断线判定
- token 自愈：初次 1006 属正常（SnowLuma 的 HTTP/WS token 不同），从 `homeDir/config/onebot_<QQ号>.json` 重新发现 WS token/端口后重连；自愈失败打明确日志（提示检查 homeDir）
- 断线指数退避重连（1s→30s 封顶）；**绝不启动/停止 SnowLuma**（EULA §5.4）
- 事件订阅：`message/private`、`message/group`（含 `notice` 戳一戳给 `poke` 字段）；其余事件忽略并计数
- 事件 → CONTRACT `hook/message` 载荷的转换函数做成**纯函数**（可单测）

### 3. 上报到脑 `src/httpd/`

- 转换后的载荷 POST 到 `mind.hookUrl`（带 `X-Memory-Token`）；按 CONTRACT §2 处理响应：
  - `200` 完成；`400` 记日志并丢弃（形状错是网关 bug，修网关）；`401` 告警 token 不匹配；`403` 该会话进本进程降频缓存 10 分钟（仍正常接收，仅降低上报频次为 1 次/分钟兜底心跳一次）
- 脑不可达：内存队列重试（指数退避 1s→30s），单条最多保留 5 分钟，超时丢弃记日志
- `/health` 端点按 CONTRACT §4（`online` 反映 OneBot 连接状态）

### 4. 发送 `src/send/`

- `POST /send` 端点按 CONTRACT §3 解析（token 校验）；`messages` 逐条发（`send_private_msg` / `send_group_msg`），条间 `minIntervalMs`
- 限流：`maxPerMinute/maxPerHour` 滑窗计数，超限 → `429 + X-Retry-After-Ms`；已有任务先到先发（简单队列，P1 不排序不并发）
- `replyToMessageId` → OneBot 的 `reply` 消息段；响应体按 CONTRACT §3（含部分失败 `failed[index]`）
- 发送结果（成功/失败/限流）记日志 + 简单计数（v1 不做面板）

### 5. 测试

- 从 ds-memory 复制契约 fixture（`tests/contract/*.json`）——**逐字段断言** OneBot 事件 → hook payload 转换
- Mock OneBot WS/HTTP 服务器：起一个假 OneBot（收到事件、接收发送请求并回 message_id），跑「事件→上报→等待脑不存在的场景重试队列」「发送→限流 429」的集成测试
- token 自愈逻辑单测（伪造 homeDir 下的 onebot_*.json）

### 6. 出口条件

- tsc 零错误；双端契约 fixture 全对；`node src/main.ts` 起得来（连不上 SnowLuma 只是告警，进程不退）
- 手工验收（需要用户参与 SnowLuma 扫码）：真 OneBot 连上后，用 curl 打本地 `/send` 发一条私聊给自己小号 QQ，确认收到
- 依赖 ≤ 5；无脑侧逻辑混入

## 四、跑偏警告

1. **不许代启 SnowLuma**（EULA）；安装/扫码/开 OneBot 端口是用户本人动作，你的代码只探测
2. 别把权限/过滤写进来——那是脑的职责，网关越权的每一行都会被评审打回
3. 别引 SDK 全家桶：OneBot v11 契约稳定，手写 WS 帧与 action 调用即可
4. 队列要有界（内存 200 条 / 5 分钟 TTL），不能无限积压
5. token/账号信息进日志前过 redact（抄 ds-memory 的实现）

## 五、完成后

回执：tsc/test 输出、连通性实测记录、依赖清单。通过后进入与 ds-memory 的联调（两进程对打 CONTRACT fixture）。