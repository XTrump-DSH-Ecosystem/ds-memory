# P2 交付记录 · QQ 接入与常驻服务

> 验收日期：2026-11-04
> 契约基线：`docs/CONTRACT.md` v1.2.1（v1.2 为已签署权限收紧；v1.2.1 为 `mapping-pair` fixture schema 扩展，无线上字段变化）
> 代码基线：commit `11141a9`（`P2 security: 群聊仅管理员可唤醒（v1.2）`）；P2.1 收尾与 P3-0 评测基线随本文件所在提交入库（未 push）
> **最终结论：P2 ACCEPTED（真实闭环 PASS，无阻塞缺陷）**。P2 代码阶段冻结，暂不新增功能。

## 1. 范围与结论

P2 为私人 DeepSeek 账号接入 QQ 私聊与一个三人小群，交付：

- `/hook/message` 接收、鉴权、权限、eventId 去重与 Receipt 持久化；
- L0 完整原文、独立昵称/引用元数据、有界唤醒包；
- 多会话 Agent、同会话串行、跨会话隔离；
- `QqClient` 发送与 429/部分失败/index 映射失败矩阵；
- 常驻 `--serve`、单实例锁、`/status`、健康轮询、优雅关闭；
- CLI 默认行为保持兼容。

不在 P2：本地语义检索（P3）、数据库/消息队列/微服务/容器化、OneBot/SnowLuma 协议实现、多智能体编排。

## 2. 架构与数据流

```text
qq-gateway
  → POST /hook/message（token → 形状 → 权限 → eventId 去重）
  → 同步写 L0 user 完整原文 + Receipt received → 200
  → SessionInbox（每会话 FIFO）
  → 窗口合批 + WakePacket（群 mention 过滤）
  → AgentRegistry.runExclusive(sessionKey)
  → Agent.runTurn（不写 user/assistant L0）
  → ReplyPlan
  → QqClient.send（429 只重试失败尾部）
  → 按实际 sentIndexes 写 assistant L0/history
  → Receipt done / failed / stored_only
```

启动顺序：获取 `<stateDir>/ds-memory.lock` → 构造依赖 → `bootstrapFromL0()`（`processing→aborted`、L0 缺失 Receipt 补建）→ 恢复分流 → 启动 Hook → 健康轮询。

关闭顺序：停止调度 → abort 在途 → 等待回合与健康检查 → 停止 Hook → 释放本实例锁。锁采用“完整临时文件 + `linkSync` 原子发布 + cleanup lease 串行 stale 清理/release”。

## 3. 自动化验收

| 项目 | 结果 |
| --- | --- |
| `npm run typecheck` | 0 错误 |
| `npm test` | 27 files / **401 tests** 全绿（测试使用临时配置根，不依赖 live config） |
| `npm run contract:check` | 26/26 文件，26 fixtures（P2.1-G7 mapping-pair） |
| 运行时依赖 | 仅 `zod`；总依赖 4（含 3 dev） |
| 独立 Tester | PASS；三实例锁仅一个 winner；忙时窗口约 207ms（200ms 配置）；omitted 不重复等待；`--serve` + `qq.enabled=false` 退出 1 且无 `你 >`；503/`/status`/日志无绝对路径 |

## 3.1 v1.2 权限收紧与上线验证（2026-11-05）

- v1.2 收紧：白名单群只放行「持久化到 L0」；进入模型还需 `sender.qqId === ownerQQ`。非 owner 群消息 `stored_only`，不唤醒、不检索、不生成 assistant、不发送；L0 原文完整并写入内部元数据 `senderQqId` / `modelEligible=false`。旧群聊缺 `modelEligible` fail-closed。
- qq-gateway 同步：v1.2 `CONTRACT.md`、变更 hook fixture、`manifest.sha256` 三份文件两仓一致；qq-gateway `typecheck` 0、305 tests 全绿。
- 本机上线黑盒验证（只读注入，未执行真实 QQ 发送）：ds-memory PID `24948`（hook `985`）、qq-gateway PID `14052`（`803`，online，selfQqId `10003`）。非 owner 群 @ 注入 `evt:10003:message:security-test-1793806042794` → HTTP 200、L0 原文完整、`senderQqId=222333444`、`modelEligible=false`、`isAtBot=true`、Receipt `done/stored_only`、网关该时间后 `send.completed=0`；陌生私聊 200 且 L0/Receipt 0 条；`/status` `inbox.pending=0/busy=0`、`gateway=online`。

## 4. 真实闭环验收（2026-11-04）

环境：私人 QQ `10001` → 机器人 `10003`，三人群 `10002`；SnowLuma 真实运行，brain PID `38268`、gateway PID `38156`。

### 4.1 私聊

| 项 | 证据 |
| --- | --- |
| 事件 | `evt:10003:message:968094076` |
| ACK | 14:33:19.559，HTTP 200，attempt=1，13ms |
| 回复 | 14:33:23.550，`all_sent` 1 条（含 DeepSeek 推理，约 4.0s） |

### 4.2 群聊

| 项 | 证据 |
| --- | --- |
| 事件 | `evt:10003:message:-1750945716` |
| ACK | 14:33:52.062，HTTP 200，11ms |
| 回复 | 14:33:57.346，群回复送达（约 5.3s） |

### 4.3 429 / G4 真机路径

- 私聊首轮 2 条中第 2 条触发 429，`X-Retry-After-Ms=862`；脑侧只重试失败 index，约 1s 后补发成功。
- 群 3 条消息触发两次 429（`786ms` / `747ms`），全部补齐；无重复、无整包重发。
- SnowLuma 日志确认：群内发送 3 条、私聊 2 条。
- 结论：G4 的“429 只重试失败尾部、index 映射回原始请求、禁止整包重发”在真机成立。

### 4.4 真实闭环结论

私聊与群聊均完成“网关 ACK → 脑侧合批/Agent → `/send` → 实际送达 → Receipt 收尾”的完整链路；两个进程仍在线，本轮后未再发送 QQ 消息，也未关闭进程。

## 5. 观察项（不阻塞）

- 助手单轮回复 2–3 条，接近 `maxPerTurn=3`；群里略啰嗦。后续可通过提示词或调低默认值优化，不改变契约。
- 真实闭环只覆盖默认 `groupWake="mention"`；`all` 模式仍由单元/集成测试覆盖。

## 6. 未测项

- 非 win32 实机运行（锁、路径脱敏、端点文件仅 Windows 实测）。
- 长时间 soak（小时级）与生产负载下的崩溃/重启恢复；当前为千级消息设计目标内的功能验收。
- 真实多进程锁竞争压力；当前为受控交错探针，不是生产级多实例压测。
- 真实权限拒绝/白名单变更、真实 `groupWake="all"`、64KB/413 边界；均有自动化覆盖，未逐一真机复验。
- 真实 WS `get_msg` 只读验证（quote 富化路径）；若后续需要引用唤醒/引用文本，需补一次只读真机验证。
- DSH 兜底真实往返；本轮真实闭环使用 DeepSeek 官方 API。
- P2.1-G7 第 26 个 `mapping-pair` fixture 已落盘（`tests/contract/mapping/message-group-card-valid.json`），并已由网关侧字节级同步；两仓 `contract:check` 均为 26/26。

## 7. 残余风险

- `InstanceLock` 的 live cleanup lease 同步等待实测约 359ms，有界但会拖慢启动/停止。
- release 抢占场景会保留 `.release` artifact；`release()` 在无法获得 live lease 的个别边界可能返回 false 但已移除自身锁；当前未观测到双活。
- 定向 vitest 偶发 `Channel closed`（tinypool teardown），按既定规则重跑后全绿；全量与指定重跑均通过。
- `HookServer.statusProvider` 会展开 provider 返回字段；当前 service provider 只返回白名单计数，后续复用需保持该约束。
- Receipt tombstone 长期驻留内存；`bootstrapFromL0()` 同步全量扫描 L0。当前千级消息量可接受，规模增长需重新评估。
- 群回复偏长；属产品体验观察项，不是协议/正确性缺陷。

## 8. 最终结论

**P2 ACCEPTED。** 真实私聊/群聊闭环、429 尾部重试、Receipt 收尾与进程常驻均通过；自动化门禁 `typecheck` 0、401 tests、`contract:check` 26/26；无新增运行时依赖。P2 代码冻结，后续只做真实环境观察、提示词/默认值调优与 P3 语义检索，不改变已签署契约。
