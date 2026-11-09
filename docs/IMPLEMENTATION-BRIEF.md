# 实现交接提示词（给 Flash 模型）

> 用法：把本文件**整篇**发给实现模型（新开会话），并附上仓库路径。
> 项目路径：`E:\workspace\ds-memory`
> 你的任务范围先冻结在 **P0**，P1-P4 未经允许不要提前动工。

---

## 一、你的角色与铁律

你在实现一个**自建的有记忆私人 AI 助理**（代号 ds-memory）。规划已完成，你负责写代码。开工前先读这两份权威文档，**它们说了算，出现冲突以 ARCHITECTURE.md 为准**：

1. `docs/ARCHITECTURE.md` —— 8 条 ADR（设计决策）+ 接口签名 + token 经济表
2. `README.md` —— 配置语义、目录结构、路线图

铁律（违反即返工）：

1. **不破坏分层**：`memory` 不 import `provider`；`agent` 不 import QQ 协议细节；层间只走接口。跨层读文件同理禁止。
2. **不提前实现**：P1-P4 的东西（QQ/embedding/压缩/网页 UI）现在只留接口与配置槽位，不写实现。特别地：检索注入、facts 衰减等属于 P1，P0 不写。
3. **依赖最小**：总依赖 ≤ 5 个。Node 24 内置 fetch / 测试用 vitest 算在 5 内。不要引入 zod 之外的验证库、不要 ioredis/prisma/框架级的东西。
4. **状态文件人类可读**：JSONL + JSON，能被 `tail`/记事本直接看懂，注释写清楚每个字段含义。
5. **凭据纪律**：API key 只从 `.env` 读（如 `DEEPSEEK_API_KEY`），永远不进日志、不进 prompt、不进 state。提供 `redact()` 工具函数并实际使用。

## 二、P0 范围清单（做完即停）

按此顺序，每项做完跑对应验证再下一项：

### 1. 项目骨架
- `package.json`（type: module，Node ≥24 engines）、`tsconfig.json`（`strict`、`noUncheckedIndexedAccess` 必开）、`vitest.config.ts`、`.gitignore`（忽略 `node_modules/`、`state/`、`.env`、`config.jsonc`）、`.env.example`（只含 `DEEPSEEK_API_KEY=` 一行）
- `npm install` 后提交 `package-lock.json`
- 验证：`npx tsc --noEmit` 零错误；`npm test` 能跑（先放一个占位测试，后续补真）

### 2. 配置层 `src/config/load.ts`
- 读 `config.jsonc`（支持注释——自己写 40 行内的 stripComments，不要为此引入库）；缺失时回退 `config.example.jsonc`
- 用 zod 校验 + 默认值收敛（结构参考 README 配置一览，P0 只实现 `provider`、`stateDir` 两段，其余字段定义了但不消费）
- 验证：单测覆盖「缺文件→默认值」「坏文件→明确报错并指出键名」「注释被正确剥离」

### 3. Provider 层 `src/provider/`
- `types.ts`：按 ARCHITECTURE.md 的接口签名实现 `Provider` / `ChatEventStream`（流式）
- `deepseek.ts`：官方 REST（`https://api.deepseek.com/v1/chat/completions`，OpenAI 兼容）SSE 流式解析；超时 + 中止信号；从事件中提取 usage（`usageOf`）
- `dsh.ts`：只注册 provider 骨架（`health()` 返回未实现），完整实现是 P1/P2 后的事
- `index.ts`：按配置选 provider
- 验证：集成测试起一个本地 mock SSE 服务器，断言流式事件顺序与 usage 提取正确；断流/超时能干净退出

### 4. 记忆 L0 `src/memory/store.ts`
- append-only JSONL，`state/memory/events/YYYY-MM.jsonl` 按月分片
- 记录 schema：`{ id, src: 'cli'|'qq', sessionKey, t, role: 'user'|'assistant', text }`（文本截断上限 4000 字，截断打标记）
- 同 id 去重；写入失败只告警一次、不打断对话
- 验证：单测覆盖分片、去重、截断、损坏行跳过

### 5. Agent 最小闭环 `src/agent/` + `src/main.ts`
- 读 `persona.md`（不存在则用内置极简人设）作为 system prompt **静态段**；动态段（用户新消息）单独拼接在后——从第一天就遵守前缀缓存纪律（ADR-5，绝对时间戳禁止进静态段）
- CLI 对话循环（readline）：多行回车发送、`/exit` 退出、`/clear` 清屏（不动历史文件）、`/status` 打印当前 provider/配置摘要
- 每轮开始和结束各向 L0 落盘一条（user/assistant）；保留最近 20 轮进上下文窗口
- 流式打字输出；`Ctrl+C` 中断本轮但进程不崩
- 验证：手工跑通 CLI 对话；`tail state/memory/events/*.jsonl` 能看到带 schema 的记录；重启后 `!`——（P0 无记忆检索，重启只校验文件可读）

### 6. 收尾
- `npm test` 全绿；写 `docs/P0-DONE.md`：记录你实际做了/没做/踩过的坑（三列表，一页以内）
- 给评审方回执：`npm test` 输出、CLI 实测截图式文字记录、最终依赖清单（`npm ls --depth=0`）

## 三、验收标准（P0 出口条件）

- `npm install && npm test && npm run dev` 三连全通
- CLI 与真实 DeepSeek API 往返成功一次（用户会提供 key）
- L0 落盘记录人类可读、带 schema 字段
- tsc strict 零错误；依赖 ≤ 5
- 无任何 P1+ 功能的实现代码混入（只有接口与配置槽位）

## 四、常见跑偏警告（规划侧已预判，不要犯）

1. 不要给每轮对话做检索/记忆注入——那是 P1，且是"触发式"的
2. 不要把当前时间戳拼进 system prompt 静态段
3. 不要引入 ORM/数据库/向量库——P0 只有 JSONL
4. 不要写 README 之外的文档（ARCHITECTURE.md 已权威）
5. 不要用 pnpm/yarn 改锁文件格式，统一 npm
6. 路径全程无空格约束不适用于本项目（那是 fork 的历史包袱），但注意 Windows 路径反斜杠

## 五、完成后记得

把 `docs/P0-DONE.md` 和回执交给规划侧评审，评审会按 ARCHITECTURE.md 逐条比对，过了才解冻 P1 提示词。