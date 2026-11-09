# P0 交付记录

> 范围冻结在 IMPLEMENTATION-BRIEF.md 的 P0 清单；P1 及以后未动工。
> 验收出口条件逐条对应：`npm install && npm test && npm run dev`、L0 可读、tsc strict 零错误、依赖 ≤ 5、无 P1+ 实现混入。

## 一页三列表

| 做了 | 没做（有意） | 踩过的坑 |
|---|---|---|
| 本地 `git init`（分支 main，未配置 remote、未 push） | P1：facts 衰减 / selfNote / bigram 检索 / 触发策略 / 注入预算 / 压缩 | Node 24 原生跑 TS 必须用 `.ts` 扩展名导入；`erasableSyntaxOnly` 下不能用构造函数参数属性，一律显式赋值 |
| 骨架：package.json（ESM、engines ≥24）、tsconfig（strict + noUncheckedIndexedAccess）、vitest、.gitignore、.env.example | P2：OneBot 网关 / 会话映射 / 两档权限 | zod `.default({})` 不会触发内层字段默认值，每个嵌套对象都显式给完整默认对象；`as const` 防止 enum 字面量被拓宽成 string |
| 配置层：40 行内注释剥离（字符串内 `//` 不误删）、config.jsonc → example → 内置默认回退、zod 校验、坏键名报错 | P3：EmbeddingRetriever / 语义检索 | 目录被同名文件占位时 `readdirSync` 抛 ENOTDIR；索引扫描必须兜住，否则「写失败只告警一次」会变成崩溃 |
| Provider：DeepSeek REST SSE 流式（超时/中止/usage/坏块跳过/HTTP 错误脱敏）、DSH 仅骨架 | P4：网页 UI / 产物索引 / owner 本机工具 | PowerShell 管道可验证 CLI 非交互路径；P0 的 busy 期间输入会被忽略（简化，不影响日常交互） |
| L0：按月分片 JSONL、同 id 去重、4000 字截断打 `…[truncated]`、坏行跳过、写失败只告警一次 | QQ 协议细节、工具注册、persona.md（留给用户撰写，内置兜底已可用） | 本机没有 `DEEPSEEK_API_KEY`，真实 API 往返未做；用本地 mock SSE 集成测试覆盖流式与超时/中止 |
| Agent：静态 system 段只构建一次（无时间戳）、动态段单独拼、最近 20 轮、每轮 user/assistant 双落盘、usage 累计 | 真实 DeepSeek API 往返（等用户提供 key 后复验） | Node 的 `process.loadEnvFile` 已在 main 内调用，因此去掉了 `--env-file-if-exists`，避免缺 .env 时的启动噪音 |
| CLI：流式输出、`/status` `/clear` `/exit`、行尾 `\` 续行 + 空行发送多行、Ctrl+C 中断本轮不崩 | — | — |
| 测试 27 条（6 个文件）：配置 7、存储 5、prompt 4、脱敏 3、agent 3、DeepSeek 集成 5 | — | — |

## 回执

### 1. 类型检查与测试

```
$ npx tsc --noEmit
（零输出，退出码 0）

$ npm test
 Test Files  6 passed (6)
      Tests  27 passed (27)
   Duration  975ms
```

覆盖要点：缺文件→默认值 / 坏文件报键名 / 注释剥离与字符串内 `//` / 部分嵌套补默认；L0 分片、去重、截断、坏行、写失败；静态 prompt 稳定且无日期；中断保留半截回复；真实 mock SSE 的事件顺序与 usage、超时、外部中止、HTTP 401 脱敏、缺 key 提示。

### 2. CLI 实测（无 key 的非交互路径）

```
$ "/status`n/exit" | node src/main.ts
[warn] 未找到 config.jsonc，正在使用 config.example.jsonc（建议复制一份再改）
  小鲸鱼 · xds-memory · P0
  provider : deepseek (deepseek-chat)
  state    : E:\workspace\ds-memory\state
  persona  : 内置兜底（未找到 persona.md）
  ...
  当前状态
    provider    : deepseek (deepseek-chat)
    baseUrl     : https://api.deepseek.com
    stateDir    : E:\workspace\ds-memory\state
    session     : cli:owner
    context     : 0 条消息（上限 20 轮）
    tokens      : 输入 0 / 输出 0 / 合计 0
```

```
$ "你好" | node src/main.ts
[warn] 缺少环境变量 DEEPSEEK_API_KEY（请写入 .env）
你 > [error] 模型调用失败：缺少环境变量 DEEPSEEK_API_KEY（请写入 .env）
```

### 3. L0 落盘样例行（`state/memory/events/2026-11.jsonl`）

```json
{"id":"93c50acf-7145-49d9-abb2-afbe1efbd98f","src":"cli","sessionKey":"cli:owner","t":"2026-11-02T17:22:32.939Z","role":"user","text":"你好"}
```

字段含义：`id` 去重键；`src` 入口；`sessionKey` 会话；`t` ISO 时间（本地月份分片）；`role` 说话人；`text` 原文（超 4000 字截断打标记）。重启后可直接读取校验，P0 不做检索。

### 4. 依赖清单

```
$ npm ls --depth=0
├── @types/node@24.19.2
├── typescript@5.9.3
├── vitest@3.2.7
└── zod@4.6.7
```

运行期依赖只有 zod；总依赖 4 个（≤ 5）。`npm audit --omit=dev` 为 0 漏洞（初版 zod 3 有一条 high 告警，已升到 4.6.7 消除；dev 依赖链的 3 条告警未处理）。

## 待用户复验

1. 在 `.env` 填入 `DEEPSEEK_API_KEY` 后跑 `npm run dev`，与真实 API 往返一轮，确认流式输出与 usage 累计。
2. 需要自定义人设时新建 `persona.md`（当前使用内置兜底）。

## 纪律自查

- `memory` 未 import `provider`；`agent` 未 import QQ 协议；`provider` 未 import `config`（只吃结构化的 ProviderSelection）。
- 时间戳没有进入 system 静态段；静态段同一人设逐轮一致（有单测断言）。
- 未引入 ORM/数据库/向量库；未写 P1+ 实现代码；未上传远程仓库。
