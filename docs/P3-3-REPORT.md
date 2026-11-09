# P3-3 · 进程内小模型语义检索可行性报告

> 状态：**可行性验证通过，尚未接入生产**。本次未修改 `src/`、`package.json`、线上配置或 `docs/CONTRACT.md`。
> 日期：2026-11-05
> 候选：`onnx-community/bge-small-zh-v1.5-ONNX`（`q8` 量化） + `@huggingface/transformers@4.3.2`

## 1. 目的与边界

验证“无向量库、进程内 embedding、暴力余弦 + 词法证据门”能否同时满足 P3-1 的质量、延迟、内存和体积门槛。实验代码与依赖全部隔离在：

- `E:\workspace\.spikes\p3-onnx`
- 模型文件：`E:\workspace\.models\bge-small-zh-v1.5-onnx`
- 缓存：`E:\workspace\.cache`

未把实验依赖加入 `ds-memory`，未启动 Ollama，未改动生产检索路径。

## 2. 选型与许可

| 项目 | 结果 |
| --- | --- |
| 模型 | BAAI bge-small-zh-v1.5 的 Transformers.js ONNX 转换 |
| 模型许可 | MIT |
| 推理运行时 | `@huggingface/transformers@4.3.2`，Apache-2.0 |
| 维度 | 512 |
| 量化 | `q8`（`model_quantized.onnx`） |
| 向量库 | 不使用；内存数组 + 余弦相似度 |

文件 SHA-256：

```text
99A6E522710C00220C89F8C52E0CC5AA09D4CBB1C34C0E932EAB3A9DFDC65DF3  onnx/model_quantized.onnx
952623481CA8BEEA884E3D3C9ECAF8A3C7BF1D0C21DE29E970CD31AF9D37A90B  onnx/model_quantized.onnx_data
3D09C84EBD10306706A79A8276B3AB736A40D8EC03251C7639F4E52C3A1A4F8E  tokenizer.json
```

## 3. 质量结果

### 纯向量

`cases-v2` 上 Recall@5=`1.0000`、正例 MRR=`0.9778`；但负例正确率仅 `0.200`。纯向量会无条件返回 top5，不能单独作为生产检索器。

### Hybrid（bigram + BGE + 现有词法证据门）

| 数据集 | Recall@5 | MRR(positive) | MRR(all) | 负例正确率 | 隔离泄漏 |
| --- | --- | --- | --- | --- | --- |
| `cases-v2.json` | 1.0000 (47/47) | 0.9889 | 0.9900 | 1.000 | 0 |
| `dev-cases.json` | 1.0000 (44/44) | 0.9750 | 0.9808 | 1.000 | 0 |

结论：**词法证据门必须保留**；BGE 只负责候选与语义排序，不能独立决定“是否命中”。

## 4. 性能与资源

| 指标 | 结果 |
| --- | --- |
| 模型加载 | 144ms（直接进程内首次加载） |
| 文档索引（20–33 条） | 26–41ms |
| Hybrid 热查询 p50 | 2.58–2.85ms |
| Hybrid 热查询 p95 | 3.91–4.87ms |
| 纯向量热查询 p50/p95 | 0.95ms / 2.17ms |
| 直接模型进程 RSS | 132.0–145.6MB |
| Hybrid 评测进程 RSS（不含 HTTP 垫片） | 86.3–92.6MB |
| npm 包解压体积 | 472.7MB |
| 模型文件 | 23.2MB |
| 运行时总增量 | 约 495.9MB（不含 npm cache） |
| npm 安装包数 | 45 |

延迟与内存均明显低于 P3-1 门槛；“按总量相加”的最坏估算仍低于 250MB，远低于 2GB 上限。

## 5. 关键发现

1. 网络运行时不要依赖 Node 直连 Hugging Face：本次 Node `fetch` 超时，手工将模型下载到 E 盘后使用 `localModelPath` 成功。
2. 查询 instruction 没有收益，本次采用原查询；模型卡允许 v1.5 不加 instruction。
3. 纯 BGE 负例正确率低，生产必须沿用现有“数字/英文硬锚点 + 中文证据槽 + split-evidence 弃权”门。
4. 当前无向量库也能满足规模：文档向量常驻内存，余弦计算是微秒级；真正成本是模型加载、依赖体积和模型分发。

## 6. 尚未完成的生产条件

- 新增 `@huggingface/transformers` 会让生产依赖树从 1 个直接依赖扩展到 45 个安装包，需明确是否接受约 496MB 增量。
- 模型文件不能直接提交进 git；需要确定首次安装/校验/失败降级的交付方式。
- `dev-cases.json` 和 `cases-v2.json` 均已被查看，不构成盲测；生产前必须建立新的未查看 holdout。
- 生产别名表、embedding 缓存失效、模型缺失/损坏时回退 bigram 尚未实现。
- 本次实验的 HTTP 垫片只用于复用既有 evaluator，不代表未来进程间架构。

## 7. 裁决建议

技术上可行，且 `bge-small-zh-v1.5 q8 + bigram + 证据门` 的质量、延迟、内存、体积全部在门槛内。但生产接入涉及新增第三方运行时、约 496MB 分发物和模型交付流程，不能把本次 spike 自动视为上线授权。

建议进入 **P3-4 生产设计**，先解决依赖接受度、模型分发和独立 holdout，再改 `src/`。
