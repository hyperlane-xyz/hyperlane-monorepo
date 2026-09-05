---
'@hyperlane-xyz/metrics': patch
---

Moved per-chain value-at-risk success logs to debug level to reduce repeated log serialization and ingestion in warp monitors and rebalancers. Retained per-token balance/value observations at info level and preserved all metric series.
