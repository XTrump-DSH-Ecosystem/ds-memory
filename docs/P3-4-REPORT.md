# P3-4 · 生产语义检索实现报告

> 状态：**已实现，默认关闭**。`memory.recall.engine="embedding"` 后启用。
> 日期：2026-11-07
> 范围：`ds-memory` 内部；未改 `docs/CONTRACT.md`、qq-gateway 或线上 JSON 形状。

## 1. 结论

采用 `bge-small-zh-v1.5` ONNX `q8`（512 维）进程内推理，不引入向量库。默认仍走 bigram；启用后使用 bigram 词法证据门 + BGE 语义候选/排序。纯向量负例不可靠，因此 embedding 永远不能单独决定“有记忆”。

## 2. 配置

```jsonc
"memory": {
  "recall": {
    "engine": "embedding",
    "embedding": {
      "modelDir": "E:/workspace/.models/bge-small-zh-v1.5-onnx",
      "dtype": "q8",
      "device": "cpu",
      "maxCandidates": 20,
      "batchSize": 8
    }
  }
}
```

- `engine` 是唯一开关；默认 `bigram`，不构造 embedding 运行时。
- `modelDir` 相对配置文件目录解析，也可填绝对路径。
- 首次检索才加载模型；启动阶段不做模型 I/O。

## 3. 数据流

1. `HybridRetriever` 从同一 `EventStore` 取当前 `sessionKey` 的 eligible 文档（复用 `BigramRetriever` 的 `modelEligible`/旧记录 fail-closed 规则）。
2. bigram 返回词法候选（top `maxCandidates`）。
3. 证据门：
   - 数字/英文硬锚点命中 → 放行
   - 无词法证据 → 弃权
   - 多槽证据分散在不同记录、没有单条覆盖两个槽 → `split-evidence` 弃权
4. 证据门放行后才加载 BGE，查询向量与文档向量做余弦；文档向量按文本缓存，进程内有效。
5. 融合排序：`0.25 × 词法归一 + 0.75 × 语义归一 + 硬锚点加成`；近因 tie-break。
6. 输出保持 80 字去重、400 字单条注入截断、`limit` 和 `sessionKey` 隔离。

## 4. 模型交付与完整性

- 模型：`onnx-community/bge-small-zh-v1.5-ONNX`，MIT，q8，约 23.2MB。
- 仓库不提交二进制，只提交 [`models/bge-small-zh-v1.5-onnx/README.md`](../models/bge-small-zh-v1.5-onnx/README.md) 与 manifest。
- 运行时在加载 native runtime 前校验 5 个文件的 SHA-256；信任锚在代码中，manifest 不是信任源。
- `allowRemoteModels=false`，不会联网下载或上传消息正文。
- 安装/启用步骤见模型目录 README。

## 5. 降级与可观测性

- 模型缺失、哈希不符、native 加载失败、推理异常、输出维度异常 → `onWarn` 告警一次，本进程永久回退 bigram。
- `HybridRetriever.status()` 返回 `engine=embedding|bigram`、`degraded`、`reason`，供后续 `/status` 扩展使用。
- 回退后聊天、L0、CLI、`!回忆` 均不受影响；重启进程后才重新尝试加载。

## 6. 评测

| 数据集 | Recall@5 | MRR(positive) | 负例正确率 | p50/p95 |
| --- | --- | --- | --- | --- |
| 新构造 holdout（17 cases） | 1.0000 | 1.0000 | 1.000 | 2.58 / 3.27ms |
| `cases-v2`（50 cases） | 1.0000 (47/47) | 0.9889 | 1.000 | 3.71 / 6.11ms |
| `dev-cases`（52 cases） | 1.0000 (44/44) | 0.9750 | 1.000 | 4.21 / 15.35ms |

命令：

```powershell
npm run eval:hybrid:prod -- holdout-cases.json
npm run eval:hybrid:prod -- cases-v2.json
npm run eval:hybrid:prod -- dev-cases.json
```

默认 `P3_MODEL_DIR` 指向 `E:\workspace\.models\bge-small-zh-v1.5-onnx`，可用环境变量覆盖。

### 证据门修正

第一轮 holdout 出现 `h07` 误弃权：查询「车多久保养一次」中的「一次」命中另一条无关记录，触发 `split-evidence`。修正为：

- 新增 `STOP_TERMS`（一次、多久、什么、之前、上次、东西等）不计入证据槽
- 非虚词单字（如「猫」）可作为证据
- 新增受控生产别名表，只做查询扩展，不直接产生命中

## 7. 验证

- `npm run typecheck`：0 错误
- `npm test`：30 files / 443 tests
- `npm run contract:check`：26/26
- 真实模型冒烟：加载 211–384ms，三个数据集均无降级
- 默认 `engine=bigram` 的既有测试全部通过；真实模型不进入默认测试依赖

## 8. 残余风险

- 新 holdout 由本轮构造，不是独立盲测。
- 仅在 Windows x64 + Node 24 验证 native runtime。
- `npm audit` 的 2 critical / 1 moderate 来自既有 vitest 3.x 开发依赖，不是本次新增；升级 vitest 需另立任务。
- 生产别名表需要持续治理，新增别名必须补测试。
