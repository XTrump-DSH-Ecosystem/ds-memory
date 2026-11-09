# P3-2 · Hybrid 评测报告

> 状态：**评测完成，质量门槛通过；部署门槛未通过；未进入生产实现**。
> 日期：2026-11-05
> 设计：`docs/P3-2-HYBRID-DESIGN.md`
> 数据集：`tests/eval/dev-cases.json`（校准）、`tests/eval/cases-v2.json`（修正后的回归集）

## 1. 环境与范围

- Node.js 24，Windows 本机；Ollama `qwen3-embedding:0.6b`，1024 维，`Q8_0`。
- Ollama API：`127.0.0.1:11434`；模型已驻留时热查询。
- 未修改 `src/`、`package.json` 依赖、`docs/CONTRACT.md`；未新增运行时依赖。
- 评测入口：`node tests/eval/run-hybrid-eval.ts <dataset> [--verbose]`，或 `npm run eval:hybrid -- <dataset>`。
- 负例正确率包含检索隔离负例和“无对应记忆”负例；隔离泄漏单独统计。

## 2. 数据修正

原 `cases.json` 的 `c13/c14/c19/c20` 在 `cli:owner` 查询 `private:10001` 的记录，属于不可能命中的测试数据错误。原文件保留；`cases-v2.json` 只修正这 4 条的 session。

因此本文不使用旧的 `0.8511` / `0.9149` 作为比较基线，统一使用修正后的 `cases-v2`：

| 方案 | Recall@5 | MRR(positive) | 负例正确率 |
| --- | ---: | ---: | ---: |
| bigram（修正基线） | 0.9362 (44/47) | 0.9450 | 1.000 |
| embedding 单独 | 1.0000 (47/47) | 0.9889 | 0.200 |
| **hybrid** | **1.0000 (47/47)** | **1.0000** | **1.000** |

修正后的 bigram 与 hybrid 差距为 `+0.0638` 绝对 Recall，满足既有“相对基线 +0.05”的方向性门槛；但这是**同一测试集的修正基线**，不是新的独立盲测结论。

## 3. 开发集校准

`dev-cases.json` 为与 `cases.json` 不重叠的合成脱敏集，36 条语料、52 个 case：

| 方案 | Recall@5 | MRR(positive) | 负例正确率 |
| --- | ---: | ---: | ---: |
| bigram | 0.9545 (42/44) | 0.9231 | 0.875 |
| embedding 单独 | 1.0000 (44/44) | 0.9425 | 0.167 |
| **hybrid** | **1.0000 (44/44)** | **0.9875** | **1.000** |

证据门在 dev 上的拒答原因分布：

```text
lexical-evidence: 128
no-lexical-evidence: 36
hard-anchor: 32
no-eligible-doc: 8
split-evidence: 4
```

唯一的正例排序失分是 `dn02`（“公园路”同时命中 `d4` 和 `d32`，语义把 `d32` 排前）；Recall@5 不受影响，positive MRR 仍为 0.9875。

## 4. 修正回归集结果

```text
cases=50 corpus=23 deidentified=true
Recall@5=1.0000 (47/47)
MRR(all-case)=1.0000
MRR(positive-only)=1.0000
negativeAccuracy=1.000
hotQueryP50Ms=11.67
hotQueryP95Ms=15.18
hotQuerySamples=150
nodePeakRssMB=81.2
isolationLeakCount=0
gateReasons=lexical-evidence:148, hard-anchor:32, no-lexical-evidence:16, no-eligible-doc:4
```

分类别：

```text
- 近义改写: 正例 14 (Recall@5 1.0000)
- 专有名词/数字: 正例 16 (Recall@5 1.0000)
- 时间近因: 正例 2 (Recall@5 1.0000)
- 跨会话干扰: 正例 7 (Recall@5 1.0000)
- 同session隔离: 正例 6 (Recall@5 1.0000)
- 检索隔离: 负例 3 (正确率 1.000)
- 负例: 负例 2 (正确率 1.000)
```

所有拒答均为证据门主动拒答；没有通过调低/调高全局相似度阈值制造结果。`isolationLeakCount=0`。

## 5. 门槛判定

| 门槛 | 结果 | 判定 |
| --- | ---: | --- |
| Recall@5 ≥ 0.93（目标 0.95） | 1.0000 | 通过 |
| 相对修正 bigram 基线 +0.05 | +0.0638 | 通过 |
| positive-only MRR ≥ 0.90（目标 0.93） | 1.0000 | 通过 |
| 隔离/负例正确率 1.000 | 1.000 | 通过 |
| 热查询 p50 ≤ 150ms / p95 ≤ 500ms | 11.67 / 15.18ms | 通过 |
| 安装体积 ≤ 2.5GB | 3.69GB | **未通过** |
| 单进程约束 | Ollama 边车 | **未通过** |

质量门槛通过，不代表生产选型通过。P3-1 已记录边车安装体积和进程模型问题；hybrid 没有消除它们。冷启动仍沿用 P3-1 的 2.15–2.53s 进程级数据；本次 runner 的 `coldStartMs` 是已驻留模型下的探针，不能当作真实冷启动。

## 6. 结论与残余风险

- **结论**：hybrid 是当前质量最好的 P3 候选；应保留为生产化候选，不直接替换现有 bigram。
- **不进入生产实现**：仍缺后端选型（Ollama 边车 vs ONNX 进程内）、别名治理、故障降级、真实规模复测和用户授权。
- **测试集风险**：`cases-v2` 在诊断阶段已被查看过，不是完全盲测；生产前应新建未查看的 holdout。
- **别名风险**：别名组是评测用最小集合，未覆盖真实长尾；别名扩展必须审计，不能绕过 session/权限过滤。
- **弃权风险**：`split-evidence` 会误拒跨记录多跳问题；当前场景接受，未来若引入多跳检索需重新设计。
- **规模风险**：当前语料只有 23/36 条，暴力余弦与 min-max 归一化的真实规模表现未验证。

## 7. 验证命令

```text
node tests/eval/run-hybrid-eval.ts dev-cases.json --verbose
node tests/eval/run-hybrid-eval.ts cases-v2.json --verbose
npm run typecheck
npm test
```

评测产物：`run-hybrid-eval.ts`、`hybrid-aliases.json`、`dev-cases.json`、`cases-v2.json`、`inspect-hybrid.ts`；未改生产代码、未新增依赖、未 push。
