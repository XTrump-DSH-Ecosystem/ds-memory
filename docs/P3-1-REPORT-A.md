# P3-1 · 候选 A 实测报告（Ollama + Qwen3-Embedding-0.6B）

> 状态：**实测完成，主审已复核**。不宣布生产选型。仅评测，不改 `src/`、不改 `package.json`、不改 `docs/CONTRACT.md`、不改 `tests/eval/cases.json`。
> 日期：2026-11-05
> 上游：`docs/P3-1-PLAN.md`、`docs/DECISION-LOG.md`、P3-0 bigram 基线。

> **勘误（2026-11-05）**：原 `cases.json` 中 `c13/c14/c19/c20` 的 session 写错，期望记录在 `private:10001` 却从 `cli:owner` 查询，属于不可能命中的测试数据。本文的 `0.8511 → 0.9149` 比较受此影响，不能作为跨方案结论；修正后的 bigram 基线是 `0.9362`。详见 `docs/P3-EVAL.md` §7 与 `docs/P3-2-DEV-REPORT.md`。本文作为历史实测记录保留，不再作为选型依据。

## 0. 结论摘要

- 本报告只覆盖候选 A 的实测结果，不覆盖候选 B/C；结论为**评测结论**，不是生产选型结论。
- Recall@5 从 P3-0 基线的 0.8511 提升到 0.9149（绝对 +0.0638），近义改写、跨会话干扰、同 session 隔离、时间近因均达到 1.000，语义检索目标方向成立。
- 隔离本身通过：`isolationLeakCount=0`，top5 不含 `modelEligible=false`、旧群缺省、非 owner 私聊或跨 session 的 ID。c33/c34 返回的是 eligible 的 owner 记录（r13/r22/r7），不是被隔离的 r8/r21。
- 但按 `docs/P3-1-PLAN.md` §3 硬门槛，候选 A **仍未通过**：Recall@5 0.9149 低于 0.93；positive-only MRR 0.9000 达到 0.90 硬门槛但低于 0.93 目标；无阈值时负例弃权正确率仅 0.200。all-case MRR 0.8300 因负例未弃权而不可与 bigram 直接比较。
- 当前数据集上不存在同时保住召回与负例的全局阈值：阈值 0.50 可把负例正确率提到 1.000，但 Recall@5 掉到 0.8298，低于 bigram 基线。A 不能单独作为替换方案，需 hybrid 或独立 dev set 校准弃权策略。
- 安装体积实测 3.69GB（安装目录 3.09GB + `~/.ollama/models` 0.60GB），超过 §3 的 2.5GB 门槛，也超过主审抽查给出的 2GB 提案口径，需复评或触发候选 C。
- 延迟与冷启动达标：热查询 p50≈14.9–17.5ms、p95≈21.4–34.6ms；冷启动 2.15–2.53s。

## 1. 模型与口径

- 模型：`qwen3-embedding:0.6b`，Ollama 模型 ID `ac6da0dfba84`。
- 模型文件 blob：`sha256-06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439`。
- `ollama show`：architecture `qwen3`、parameters `595.78M`、context length `32768`、embedding length `1024`、quantization `Q8_0`、capability `embedding`。
- Modelfile 的 `TEMPLATE` 为 `{{ .Prompt }}`，未提供官方 retrieval instruction。因此本评测使用固定口径（抄录原文）：

  `Instruct: Given a search query, retrieve relevant passages that answer the query\nQuery: ${query}`

- 查询侧：`input = 上面模板中的 query 替换为 case.query`。
- 文档侧：`input = corpus.text` 原样，不加 instruction。
- 向量：Ollama 返回 1024 维 embedding；相似度用余弦（先 L2 归一化再点积）。

## 2. 环境与后端

- Node `v24.15.0`、Windows、GPU `RTX 5060 Ti 8GB`、驱动 `610.88`、CUDA UMD `13.3`。
- `ollama ps` 显示 `qwen3-embedding:0.6b`：`100% GPU`、runner `llamacpp`、加载规模 `1.2 GB`、context `4096`（runner 默认 num_ctx）。
- 后端结论：**GPU/CUDA 后端**（`ollama ps` 明确 `100% GPU`）。
- `nvidia-smi` 实测：显存 `4965 MiB / 8151 MiB`（系统总占用，包含桌面 GUI 等进程）；Ollama runner（`llama-server.exe`，PID 40080）出现在 compute 进程列表，但每进程显存显示 `[N/A]`（权限不足，无法精确归因）。以上如实记录，不把系统总显存全部归因到 Ollama。

## 3. 实测指标

### 3.1 冷启动

- 口径：每次计时前先执行 `ollama stop qwen3-embedding:0.6b`，随后由 runner 的第一次 `/api/embed` 请求计时；runner 计时前不做任何预热。
- 三次冷启动采样：`2150.2 ms`、`2195.0 ms`、`2533.5 ms`。
- 已加载后的 warm 首请求约 `42.6 ms`（仅作对照，不计入冷启动）。

### 3.2 召回质量（instruction 模板口径，两次冷跑结果一致）

- `Recall@5 = 0.9149 (43/47)`
- `MRR(all-case) = 0.8300`
- `MRR(positive-only) = 0.9000`；P3-0 同口径 positive-only 基线为 `(0.8650×50−5)/45 = 0.8500`
- `negativeAccuracy(无阈值) = 0.200`（5 条负例仅 c35 候选集为空）
- `isolationLeakCount = 0`
- `cases=50 corpus=23 deidentified=true`
- 分类：
  - 近义改写：正例 14，Recall@5 `1.0000`
  - 专有名词/数字：正例 16，Recall@5 `0.7500`
  - 时间近因：正例 2，Recall@5 `1.0000`
  - 跨会话干扰：正例 7，Recall@5 `1.0000`
  - 同session隔离：正例 6，Recall@5 `1.0000`
  - 检索隔离：负例 3，弃权正确率 `0.333`
  - 负例：负例 2，弃权正确率 `0.000`

负例 top1 明细（用于区分“隔离”与“弃权”）：

| case | 查询 | top1 | 相似度 | 判定 |
| --- | --- | --- | --- | --- |
| c33 | 普通群友的秘密计划 | r13（owner，eligible） | 0.4824 | 无隔离泄漏；未弃权 |
| c34 | 群友小王家的橘猫 | r13（owner，eligible） | 0.3969 | 无隔离泄漏；未弃权 |
| c35 | 陌生人的秘密计划 | 无候选 | — | 正确弃权 |
| c36 | 护照号码 | r12（CLI owner） | 0.4670 | 未弃权 |
| c37 | 疫苗接种记录 | r12（CLI owner） | 0.2689 | 未弃权 |

### 3.3 延迟与内存

- 热查询（单 query embedding + 相似度检索）：
  - 第 1 次：p50 `17.52 ms`、p95 `34.56 ms`、样本 `150`
  - 第 2 次：p50 `16.59 ms`、p95 `22.61 ms`、样本 `150`
  - 主审复跑：p50 `14.88 ms`、p95 `21.44 ms`、样本 `150`
- 冷启动：主审复跑 `2533.5 ms`；此前两次 `2150.2 ms`、`2195.0 ms`。
- Node runner 峰值 RSS：`80.4 MB`、`81.0 MB`、`81.1 MB`。

### 3.4 资源占用

- Ollama 常驻进程 working set：
  - `llama-server`：`629.80 MB`（Private `2084.00 MB`）
  - `ollama`：`61.70 MB`（Private `75.80 MB`）
  - `ollama app`：`44.70 MB`（Private `55.10 MB`）
  - 合计 working set：`736.20 MB`；合计 Private：`2214.90 MB`
- Ollama + runner working set 合计：`736.20 MB + ~81 MB ≈ 817 MB`。
- 安装体积（2026-11-05 已迁至 E 盘）：
  - 程序 `E:\Ollama`：`3.09 GB`
  - 模型 `E:\Ollama\models`：`0.60 GB`
  - 合计：`3.69 GB`（不隐去）。
- C 盘清理：原 `%LOCALAPPDATA%\Programs\Ollama` 与 `~/.ollama/models` 已删除；仅保留 `~/.ollama` 的密钥/标记约 2.5KB。`OLLAMA_MODELS` 已设为 `E:\Ollama\models`。
- npm 依赖增量：`0`。

## 4. 与门槛对照

- 质量硬门槛（`docs/P3-1-PLAN.md` §3）：
  - Recall@5 ≥ 0.93 且相对基线绝对提升 ≥ 0.05：`0.9149 < 0.93`（未达标）；提升 `+0.0638`（达标）。整体未达标。
  - MRR ≥ 0.90 且不低于基线：`positive-only 0.9000 ≥ 0.90`（硬门槛达标），但低于 `0.93` 目标；`all-case 0.8300` 因负例未弃权不可直接比较，不作为淘汰依据。
  - 检索隔离与负例正确率 1.000：隔离泄漏 `0`（达标）；弃权正确率 `0.200`（未达标）。
- 性能/资源门槛：
  - 热查询 p50 ≤ 150ms、p95 ≤ 500ms：达标；目标值 p50 ≤ 80ms、p95 ≤ 250ms 亦达标。
  - 冷启动 ≤ 60s：达标（2.15–2.53s）。
  - 内存增量 ≤ 2.5GB：working set 口径 ≈817MB 达标；Private 口径 ≈2.215GB 接近但未超 2.5GB，需继续监控。
  - 安装体积 ≤ 2.5GB：`3.69GB` **未达标**；同时超过主审抽查的 2GB 提案口径。

## 5. 关键风险与失败模式

- embedding top-k 对非空候选总会返回结果，没有相似度阈值。隔离未泄漏（`isolationLeakCount=0`）；c33/c34 返回的是 eligible 的 owner 记录，不是非 owner 内容。真正未解决的是“何时弃权”。
- 当前测试集上阈值与召回不可兼得：`T=0.50` 时负例正确率 1.000，但 Recall@5 降至 0.8298；`T=0.40` 时 Recall@5 0.9149、负例正确率仅 0.600。该表只作诊断，阈值必须在独立 dev set 校准，不能用这 5 条测试集调参。

| 阈值 | Recall@5 | positive-only MRR | 负例正确率 |
| --- | --- | --- | --- |
| 0.30 | 0.9149 | 0.9000 | 0.400 |
| 0.35 | 0.9149 | 0.9000 | 0.400 |
| 0.40 | 0.9149 | 0.9000 | 0.600 |
| 0.45 | 0.8936 | 0.8778 | 0.600 |
| 0.50 | 0.8298 | 0.8111 | 1.000 |

- all-case MRR 从基线 0.8650 降至 0.8300，主因是负例未弃权；positive-only MRR 0.9000 高于 baseline 0.8500，质量并非全面下降。
- 安装体积 3.69GB 超门槛：主要来自 Ollama 运行时安装目录 3.09GB，模型本身仅约 0.60GB。不得为凑门槛删除数据。
- Ollama 为 sidecar，破坏 ds-memory 单进程约束；未启动/崩溃/端口冲突时需降级 BigramRetriever。本评测只验证探针可用，未实现生产降级与告警。

## 6. 建议

- 不建议直接把候选 A 作为替换 bigram 的默认方案；也不建议因“隔离 0.333”误杀 A。隔离已通过，阻塞点是弃权策略与安装体积。
- 首选下一步：设计 **hybrid（bigram 精确匹配 + embedding 语义召回 + 独立弃权策略）**，在独立 dev set 上校准阈值/融合权重，再回测本 50 case；不下载新模型、不新增依赖、不改生产代码。
- 若 3.69GB 安装体积被认定为硬约束，再评估候选 C（bge-small-zh-v1.5）；该评估需要新的下载授权。
- 若保留候选 A，P3-2 必须落实：故障降级、告警、端口探测、不自动拉起边车、L0 写入不受影响。

## 7. 主审复核

- 独立复算 `isolationLeakCount=0`；c33/c34 的 top5 仅含 eligible owner 记录 r13/r22/r7，r8/r21 未进入索引。
- `MRR(positive-only)=0.9000`（40.5/45），不是 all-case 的 0.8300；报告已拆分两个口径。
- 阈值敏感性表为诊断数据，默认不选阈值；P3-2 必须在独立 dev set 上校准。
- 复跑命令：`node tests/eval/run-embedding-eval.ts`；`npm run typecheck` 0 错误。未改 `src/`、`package.json`、`docs/CONTRACT.md`、`tests/eval/cases.json`。
