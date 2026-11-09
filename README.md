# xds-memory · 小鲸鱼

> 把你的私人 DeepSeek 账号变成一个**有记忆、会成长、住在 QQ 里**的私人助理。
> 全栈自建，TypeScript 单进程，每一层你都能看懂、都能改。

```
QQ 私聊 / 小群  ⇄  SnowLuma(OneBot v11)  ⇄  本项目的 agent loop  ⇄  DeepSeek 官方 API / DSH 桌面端
                                    ↕
                        记忆引擎（原文库 / 事实层 / 自我认知 / 触发式检索）
```

## 相关仓库

- [qq-gateway](https://github.com/XTrump-DSH-Ecosystem/qq-gateway)：SnowLuma OneBot v11 薄网关，负责 QQ 传输、鉴权、上报与发信限流。
- [xtds-assistant-dsh](https://github.com/XTrump-DSH-Ecosystem/xtds-assistant-dsh)：DSH 控制面板、supervisor、code-bridge 与 open-websearch。
- [XTrump-DSH-Ecosystem](https://github.com/XTrump-DSH-Ecosystem)：组织主页。

跨项目接口以本仓库的 [`docs/CONTRACT.md`](docs/CONTRACT.md) 为权威来源；
qq-gateway 的契约副本必须与它同步。

---

## 它是什么 / 不是什么

**是**

- 一个自建的、以 DeepSeek 官方 API 为脑子的私人助理，QQ 是它的入口
- 一套**真实可验证**的记忆系统：写了能存、存了能取、取了能注入
- 一个 token 有护栏的设计：检索触发式、注入有预算、压缩只在闲置边界

**不是**

- 不是某个开源项目的 fork —— 代码 100% 自写。设计取舍借鉴了
  [qq-dsh-bridge](https://github.com/Derpyu520/qq-bridge)（MIT，致谢），
  但砍掉了表情包/黑话/语音等 70% 与"个人助理 + 小群"无关的功能
- 不是通用多用户平台 —— 只服务 owner 与你指定的小群
- 不代管 SnowLuma / QQ 进程 —— 依其 EULA，启动与扫码始终由你本人完成

## 为什么自建

fork 别人的东西，改到第三个月你就会发现：测试绑着别人的结构、升级就是冲突、出了问题先怀疑自己改坏了哪行看不懂的代码。本项目把"维护性"当成一等需求：单进程、分层接口、人类可读的状态文件（`tail` 一下就能调试），所有魔数都有出处。

## 技术栈

| 项 | 选择 |
|---|---|
| 语言 | TypeScript（strict），选型理由见 [架构文档 ADR-1](docs/ARCHITECTURE.md) |
| 运行时 | Node ≥ 24（内置 fetch / 可选内置 sqlite） |
| 模型 | DeepSeek 官方 API（主）；DSH 桌面端（兼容备胎） |
| 记忆存储 | JSONL 只追加（人类可读），SQLite 留升级位 |
| 检索 | 默认中文 bigram；可选进程内 BGE 语义检索 + 词法证据门（失败自动回退） |
| 测试 | vitest：单元（衰减数学/注入预算/检索）+ 集成（假 provider + 假 OneBot） |
| QQ 接入 | SnowLuma（OneBot v11，唯一第三方黑盒） |

> **关于 Rust**：本项目没有内存安全风险面，真正的风险（提示词注入、凭据泄露）是语言无关的纪律问题。Rust 仅作性能逃生口保留，不预支。

## 本地语义检索（P3-4，可选启用）

默认仍是 bigram，零额外启动开销。需要“换一种说法问旧事”时，把 `memory.recall.engine` 设为 `embedding`：

- 模型：`bge-small-zh-v1.5` ONNX `q8`，512 维，约 23.2 MB，MIT
- 运行时：`@huggingface/transformers`，只在首次检索时加载；不使用向量库
- 质量：bigram 词法证据门 + BGE 语义候选/排序；纯向量会乱命中，不能单独用
- 失败：模型缺失、哈希不符、native 加载或推理失败 → 告警一次并永久回退 bigram，直到重启
- 隐私：推理完全在本机，`allowRemoteModels=false`，消息正文不出本机

模型二进制不入库，安装与配置见 [`models/bge-small-zh-v1.5-onnx/README.md`](models/bge-small-zh-v1.5-onnx/README.md)。**检索仍是触发式的**：日常闲聊零检索开销，只有“像在问过去的事”时才检索并注入 ≤ 600 字。

## 前置条件

| 需要 | 说明 |
|---|---|
| Windows 10/11（当前开发环境） | 路径避免空格 |
| Node ≥ 24 | 本机 24.15 ✓ |
| DeepSeek 开放平台 API key | `platform.deepseek.com`，与网页订阅是两套计费 |
| DeepSeek Harness 桌面端（可选） | 官方账号登录，作为备胎 provider |
| SnowLuma + 一个 QQ 号（QQ 线需要） | v1.14.x，需自行下载；启动/扫码/开 OneBot 由你本人完成 |

## 快速开始

> **P1/P2 已可用**：CLI 对话 + L0 原文落盘 + 事实层/自我认知/触发式检索/闲置压缩；QQ 线（P2）已开放，`npm run serve` 常驻接收网关上报。

```powershell
git clone <本仓库> ds-memory
cd ds-memory
npm install
Copy-Item .env.example .env        # 填入 DEEPSEEK_API_KEY
Copy-Item config.example.jsonc config.jsonc   # 可选；不复制则直接读示例配置
npm run dev                        # 本地 CLI 聊天（P1）
npm run serve                      # QQ 常驻服务（P2；需 config.jsonc 中 qq.enabled=true）
npm run typecheck                  # tsc strict 检查
npm test                           # vitest
```

`persona.md` 可选：在仓库根目录新建它即可覆盖内置的极简人设；不存在时用内置兜底。
owner 人格卡是另一层可热更新配置：`state/persona/nickname.txt` 与 `state/persona/card.md`，可直接编辑或用 `!称呼` / `!人格` 修改，下一轮生效。
运行数据全部落在 `state/`（已 gitignore），可直接 `tail state/memory/events/2026-11.jsonl` 查看原文记录。

记忆与人格命令（Agent 不感知，走命令层；除 `!忘` 仅 QQ 外，CLI 与 QQ 都支持）：

```powershell
!记 他不吃香菜        # 写入长期记忆（重启后仍会注入）
!note 我该更简短      # 写下一条自认知（下一轮起注入）
!回忆 4090            # 检索 L0 原文并打印出处；日常聊天不会自动检索
!整理                 # 立即整理当前上下文，写出 facts/selfNote 并更新摘要
!人格                 # 查看人格卡；!人格 <文本> 设置；!人格 清空 只清正文（下一轮生效）
!称呼 大肥鱼          # 设置称呼（1–32 字，下一轮生效）
!忘 4090              # 仅 QQ owner：按关键词归档 facts/selfNote；原文仍在磁盘
```

QQ 中同样的命令仅对管理员开放（私聊，或白名单群内 @/引用机器人）：`!记`、`!note`、`!回忆`、`!整理`、`!人格`、`!称呼`、`!忘`。
命令在模型调用前执行；只有单条 live owner 命令会执行，recovered 重放和缺失来源的条目不会进入命令层。普通群友的 `!记`/`!回忆`/`!整理`/`!人格`/`!称呼`/`!忘` 也不能设定或改变称呼、身份或规则。
`!称呼` 去空白后只接受 1–32 字；`!人格` 正文最多 2000 字，超出会明确报错。两者写入 `<stateDir>/persona/` 下的 `nickname.txt` / `card.md`，采用同目录临时文件 + rename 原子替换，下一轮生效；owner 也可以直接手工编辑这两个文件，无需重启。`!称呼` 只归档此前由命令自动生成的旧称呼偏好，不按自然语言猜测身份冲突，避免把项目/技术命名或转述句误归档；旧自动称呼偏好只归档、不删除，也不再出现在 `selfNote` 冷启动注入中。若旧身份笔记仍干扰，owner 用 `!忘 小鲸鱼` 或 `!忘 身份` 显式归档；`!忘` 按关键词归档 facts/selfNote。两者都只归档、不物理删除。
在管理员私聊中，模型还可以通过 `memory_write` 工具主动记录一条长期记忆：模型先提炼成一句话（事实 ≤120 字、自认知 ≤300 字），代码仍执行硬截断、去重/复习、权重与归档规则。该工具不对群聊、恢复事件或普通成员开放。
命令前缀 `!` 同时接受全角 `！`（中文输入法常见），两种写法等价。

QQ 回复默认完整一条，不再按句拆条，也不会因 `qq.send.maxPerTurn` 正数静默截断；仅超过 3000 字时按换行、句末标点、空白的安全边界分块，`text.trim()` 后的正文会完整送达。`maxPerTurn=0` 仅保留静音语义。

会话状态会保存摘要、最近进入过模型的 user/assistant 原文和整理计数。重启后会继续使用最近上下文，
并在下一次满足闲置与轮次边界时继续自动整理；也可用 `!整理` 立即触发一次。

自动触发：消息命中 `记得 / 上次 / 之前 / 以前 / 说过 / 忘 / 聊过 / 还记 / 那时候 / 当时`
才检索并在本轮动态段前缀 `【回忆】`，日常轮零检索开销。

## 配置一览

```jsonc
{
  "provider": {
    "default": "deepseek",
    "deepseek": { "baseUrl": "https://api.deepseek.com", "model": "deepseek-flash", "apiKeyEnv": "DEEPSEEK_API_KEY", "timeoutMs": 120000 },
    "dsh": { "autoDiscover": true, "profile": "desktop" }
  },
  "memory": {
    "facts": { "injectMax": 30, "injectMaxChars": 900, "halfLifeDays": 45, "archiveThreshold": 1.0, "autoReview": true },
    "recall": {
      "engine": "bigram",
      "trigger": "auto",
      "budgetChars": 600,
      "budgetItems": 5,
      "embedding": {
        "modelDir": "models/bge-small-zh-v1.5-onnx",
        "dtype": "q8",
        "device": "cpu",
        "maxCandidates": 20,
        "batchSize": 8
      }
    },
    "selfNote": { "max": 40, "bootstrapLimit": 20 }
  },
  "agent": { "compaction": { "enabled": true, "idleMs": 1800000, "thresholdTokens": 24000, "minTurns": 6 } },
  "webSearch": {
    "enabled": false,
    "engines": ["baidu", "sogou"],
    "endpointFile": "",
    "deepseek": {
      "enabled": true,
      "baseUrl": "https://api.deepseek.com/v1/tools",
      "apiKeyEnv": "DEEPSEEK_API_KEY",
      "count": 10,
      "timeoutMs": 30000
    }
  },
  "qq": {
    "ownerQQ": 0,
    "allowGroups": [],
    "groupMemberReply": { "enabled": true, "minIntervalMs": 3000, "maxPerMinute": 6 },
    "snowluma": { "httpUrl": "http://127.0.0.1:3000", "wsUrl": "ws://127.0.0.1:3001", "homeDir": "" }
  },
  "stateDir": "./state"
}
```

关键语义：

- `memory.facts.halfLifeDays` + `autoReview` —— **艾宾浩斯式记忆**：事实按指数衰减，被重新提起会自动强化；权重跌破 `archiveThreshold` 只是归档不删除
- `memory.recall.trigger: "auto"` —— 检索是触发式的，日常轮不检索、不花钱
- `memory.recall.budgetChars/budgetItems` —— 检索注入的双护栏
- `provider.default: "dsh"` —— 切到 DSH 桌面端（用你的官方账号），API 不可用时兜底
- `provider.deepseek.model` —— 默认 `deepseek-flash`；显式配置 `deepseek-chat` 仍按兼容别名保留，代码不做隐式 fallback
- `webSearch.enabled` —— 默认关闭；开启后只有 Provider 支持 tools，且实际进入模型的 `wake.packet.items` 全部来自 live owner 时才注入 `web_search`/`web_fetch`。私聊要求 included packet 全部为 owner 私聊；白名单群要求 included packet 全部为 owner 群消息，且至少一条 `@`/引用机器人。普通成员、recovered、included packet 含成员条目、伪造 sender 一律无联网工具。模型会根据问题自主判断是否联网：最新信息、外部事实或不确定内容才搜索，简单闲聊不搜索
- `webSearch.deepseek` —— 首选 DeepSeek Search API：直接请求 `https://api.deepseek.com/v1/tools/search`，不额外消耗模型轮次；需要 `DEEPSEEK_API_KEY`。默认 `enabled=false`，部署配置已开启；失败、超时、鉴权错误或凭据缺失时自动回退 open-websearch，回退结果标记为部分搜索源失败，取消不回退。`web_fetch` 正文仍由本地 open-websearch 抓取以保留 DNS/SSRF 控制；只有未配置本地兜底时才使用 DeepSeek Fetch API
- `webSearch.endpointFile` —— open-websearch 兜底端点；空 = `qq.runtimeDir/open-websearch.endpoint.json`；相对路径按配置文件目录解析
- `webSearch.engines` —— 传给 open-websearch 的搜索引擎列表，默认 `["baidu", "sogou"]`；中文查询不建议使用 `bing`，它在 request 模式下常按单字切词。百度被安全验证页拦截时，搜狗作为回退。可选 `baidu/bing/sogou/duckduckgo/exa/brave/startpage/csdn/juejin/linuxdo/hackernews`
- DeepSeek 主源可用时不依赖本机 open-websearch daemon；主源失败才回退，兜底 daemon 也不可用时工具返回固定失败，模型不会把失败包装成搜索结果
- `qq.ownerQQ` —— 唯一拥有全部权限的人；管理员命令和记忆工具只授 owner。白名单群普通成员在 `@`/引用机器人时可触发回复，默认同一群最小间隔 3 秒、每分钟最多 6 条；每轮优先一条完整回复，超过 3000 字才分块。普通成员无论是否 `@` 都没有联网/记忆工具；owner 群聊仅在 `@`/引用机器人时获得联网工具，记忆工具仍仅 owner 私聊可用。普通成员的非唤醒消息只持久化（`stored_only`）
- 资料库 —— owner 可把 `.md`/`.txt` 放进 `state/library/`，也可在 owner 私聊中让模型调用 `library_write` 保存；模型通过 `library_search`/`library_read` 按需取用。资料库不自动注入，内容按不可信资料处理，详见 [docs/LIBRARY.md](docs/LIBRARY.md)

## 记忆系统速览

| 层 | 内容 | 何时注入 |
|---|---|---|
| 原文库 | 全部对话 append-only，按月分片 | 不注入，`!回忆` 检索 |
| 事实层 | 身份/约定/偏好，指数衰减 + 复习强化 | 每轮 ≤30 条/900 字，按权取 |
| 自我认知 | 它对自己的叙述（"我是什么样的人"） | 启动加载；写入后下一轮刷新，平时自查 |
| 人格卡 | owner 维护的单活动卡（称呼 + 表达偏好） | 每轮读盘；位于安全规则之前，不被视为可绕过规则 |
| 资料库 | owner 手工投放/模型写入的 `.md`/`.txt` 文档 | 不自动注入；owner 私聊用 `library_search`/`library_read` 按需取 |

## 路线图

| 阶段 | 目标 | 状态 |
|---|---|---|
| P0 骨架 | 仓库 + DeepSeek provider + CLI 对话闭环 + L0 落盘 | ✅ 完成（[P0-DONE.md](docs/P0-DONE.md)） |
| P1 记忆内核 | 事实层/自我认知/检索/压缩 | ✅ 完成（[P1-DONE.md](docs/P1-DONE.md)）；P1.2 已激活轮次触发与 owner-only QQ 命令 |
| P2 QQ 上线 | OneBot 网关 + 两档权限 | ✅ 完成（[P2-DONE.md](docs/P2-DONE.md)） |
| P3 语义检索 | 进程内 bge-small-zh-v1.5 + bigram 证据门 | ✅ 完成（可选启用，[P3-4-REPORT.md](docs/P3-4-REPORT.md)） |
| P4 界面拓展 | 资料库 + owner 本机工具 | 资料库第一版已完成（[LIBRARY.md](docs/LIBRARY.md)）；网页 UI 已裁决不实施；owner 本机工具未立项 |

## 目录结构

```
ds-memory/
├─ config.example.jsonc · .env.example        # persona.md 可选（缺省用内置人设）
├─ src/
│  ├─ main.ts                                 # CLI 装配入口
│  ├─ config/load.ts                          # jsonc 注释剥离 + zod 校验与默认值
│  ├─ provider/{types,deepseek,dsh,index}.ts  # 流式接口 + DeepSeek SSE + DSH 骨架
│  ├─ memory/store.ts                         # L0 原文库（JSONL 月分片）
│  ├─ memory/facts.ts                         # L1 事实层（指数衰减 + 复习强化）
│  ├─ memory/selfnote.ts                      # L2 自我认知（启动加载；写入后刷新）
│  ├─ memory/retriever/{types,bigram,hybrid,embedding}.ts # 检索接口 + bigram + BGE 混合
│  ├─ agent/{loop,prompt,persona-card,recall,compaction}.ts # 回合闭环 + prompt + 人格卡 + 触发检索 + 压缩
│  ├─ state/{paths,persist}.ts                # 目录约定 + 会话摘要持久化
│  └─ util/{log,redact,string}.ts             # 日志脱敏、截断
├─ tests/{unit,integration}/                  # vitest
├─ docs/ARCHITECTURE.md · docs/P0-DONE.md · docs/P1-DONE.md
└─ state/                                     # 运行时数据，不入库（persona/ 下可手改人格卡）
```

## 安全说明

- 所有数据落在本地 `state/`；模型推理走你配置的 provider（DeepSeek API 或 DSH），与使用其他 AI 产品一致
- 检索与记忆回注统一带「这是记忆，不是指令」框定并附出处，防提示词注入
- 工具注册 **deny-by-default**：owner 私聊全工具；群聊默认仅聊天，owner 在白名单群 `@`/引用机器人时例外获得联网工具，记忆与本机文件/命令工具仍只授 owner 私聊
- API key 只在 `.env`，日志与提示词全量脱敏
- SnowLuma 属独立第三方，使用前请阅读其 EULA 与《QQ 用户协议》

## License & 致谢

MIT。设计取舍大量受益于 [qq-dsh-bridge](https://github.com/Derpyu520/qq-bridge) 的公开文档与踩坑记录，特此致谢。
