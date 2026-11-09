# P3-0 · bigram 召回基线评测

> 状态：**基线记录，非验收通过**。用于 P3 语义检索（embedding）选型对比，不代表 P3 已完成。
> 日期：2026-11-05
> 命令：`npm run eval:recall`（`node tests/eval/run-recall.ts`）

## 1. 目的

在不动 P3 实现、不下载模型、不新增依赖的前提下，为当前 `BigramRetriever` 建立一份可复现的「换说法问旧事」召回基线，供 P3 引入 embedding 检索后做同口径对比。

## 2. 数据集构造

- 位置：`tests/eval/cases.json`；runner：`tests/eval/run-recall.ts`。
- 规模：**50 个 query case**，灌库 **23 条合成 L0 记录**。
- 全部**合成、脱敏**：人名/群号/QQ 号均为虚构（如 `ownerQQ=10001`、群 `900001`、群友 `222333444`），不含任何真实账号。
- 灌库使用真实 `EventStore` + `BigramRetriever`，并按 v1.2 检索隔离语义写入 `modelEligible`/`senderQqId`。

| 覆盖类别 | 正例数 | 说明 |
| --- | --- | --- |
| 近义改写 | 14 | 显卡/图形卡/GPU、屏幕/显示器等换说法 |
| 专有名词/数字 | 16 | 朝天门、8848、6688、Wi-Fi 密码等 |
| 时间近因 | 2 | 同词命中时更近的记录应排前 |
| 跨会话干扰 | 7 | 只取查询 sessionKey，不串其他会话 |
| 同 session 隔离 | 6 | 同会话内正确命中 |
| 检索隔离 | 3（负例） | `modelEligible=false` 的群/私聊内容不召回 |
| 负例 | 2（负例） | 应不命中的查询 |

## 3. 指标口径

- `Recall@5`：正例中「期望相关记录出现在 top5 的比例」，微平均 = 命中相关数 / 期望相关总数。
- `MRR`：全部 case 的平均倒数排名；正例取首个相关文档的 `1/rank`，未命中为 0；负例命中任何结果按 0，否则为 1。
- 平均查询延迟：索引预热后，逐 query 计时（`performance.now()`）的均值，单机单次运行。

## 4. 当前基线结果

```text
cases=50 corpus=23 deidentified=true
Recall@5=0.8511 (40/47)
MRR=0.8650
avgLatencyMs=0.334
```

延迟为单机单次测量；多次运行约 0.319–0.382 ms，仅作量级参考。

按类别：

```text
- 近义改写: 正例 14 (Recall@5 0.9286)
- 专有名词/数字: 正例 16 (Recall@5 0.7500)
- 时间近因: 正例 2 (Recall@5 1.0000)
- 跨会话干扰: 正例 7 (Recall@5 0.7778)
- 同session隔离: 正例 6 (Recall@5 1.0000)
- 检索隔离: 负例 3（命中=0 正确率 1.000）
- 负例: 负例 2（命中=0 正确率 1.000）
```

## 5. 已知限制

- 纯 bigram 无语义泛化：`图形卡`/`GPU` 等换说法无法命中 `4090 显卡`；这是近义改写类的主要失分来源。
- 中文未分词，依赖 2 字滑窗；跨词边界或单字变体会漏召回。
- 时间近因仅做排序微调（30 天内 `+0.05` 封顶），不改变命中集合；本基线的时间近因正例均能命中，排名由近因与 `at` 兜底。
- 检索隔离（`modelEligible=false`、旧群缺省 fail-closed）验证为全部正确，与 v1.2 语义一致。
- 平均延迟为单机、热索引、无网络下的单次测量值（本次记录 `0.382ms`，存在运行抖动）；不含真实分片规模与冷启动建索引成本。

## 6. 结论

本评测是 **P3 选型基线**：后续接入 embedding 检索后，用同一数据集与 `npm run eval:recall` 复跑，对比 `Recall@5`/`MRR`/延迟。当前结果不作为 P3 验收依据，也不得为提升分数修改生产检索参数。

## 7. 勘误与修正基线（2026-11-05）

复核发现原 `tests/eval/cases.json` 有 4 个**不可能命中**的用例：`c13`、`c14`、`c19`、`c20` 把查询 session 写成 `cli:owner`，但期望记录 `r9`/`r23` 位于 `private:10001`。检索器严格按 `sessionKey` 隔离，因此这 4 条不是模型失分，而是测试数据错误。

处置：

- 原 `cases.json` 保持不动，作为历史记录。
- 新增 `tests/eval/cases-v2.json`，仅把这 4 条的 `sessionKey` 修正为 `private:10001`；其余查询、期望和语料不变。
- `run-recall.ts` 与 `run-embedding-eval.ts` 支持传入数据集文件名；默认仍是 `cases.json`，不改变旧命令行为。

修正后的同口径基线：

```text
cases=50 corpus=23 deidentified=true
bigram Recall@5=0.9362 (44/47)
bigram MRR=0.9450
bigram avgLatencyMs=0.298

embedding Recall@5=1.0000 (47/47)
embedding MRR(positive-only)=0.9889
embedding negativeAccuracy=0.200
```

因此，旧文记录的 `Recall@5=0.8511` 和候选 A 的 `0.9149` 都不能再用于跨方案比较；它们的上限被 4 条不可满足用例压低。后续比较以 `cases-v2` 的 `0.9362` 为 bigram 修正基线。本勘误不改变原报告的历史事实，但改变其解释与排序结论。
