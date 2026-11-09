# 契约 fixtures

本目录是 ds-memory 与 qq-gateway 共用的**唯一权威**契约测试数据源。

- 每个 `*.json` 是一个自描述 fixture，包装格式：

```jsonc
{
  "name": "唯一名称",
  "kind": "hook-request" | "send-request" | "send-response" | "endpoint" | "mapping-pair",
  "description": "说明",
  "payload": { /* 原始 JSON */ },
  "expect": { /* kind 相关期望 */ }
}
```

- `manifest.sha256` 是全部 fixture 的 SHA-256 清单（格式：`<hex>  <相对路径>`，路径用 `/`）。
- 两仓各持有一份副本与同一清单；运行 `npm run contract:check` 校验本地文件与清单一致。
- `send-response.expect` 必须带 `status` 与 `headers`；429 样例还带 `retryIndexes`/`retryAfterMs`，以固定状态与重试子集语义。
- `mapping-pair.expect`：`{ "ok": boolean, "hook": <完整 hook JSON> }`；用于 OneBot 原始事件 → `/hook` 的映射成对断言。
- 当前共 26 个 fixture，含 1 个 `mapping-pair`（card-first + reply/get_msg 成对映射）。
- 变更流程：改契约提案 → 另一侧评审 → 总负责裁决 → 更新本目录 fixtures + 清单 → 两仓同步 → 改实现。
- 禁止绕过清单直接改副本；禁止在 fixture 中写入真实 token/凭据。
