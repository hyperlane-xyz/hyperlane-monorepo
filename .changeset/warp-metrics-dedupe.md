---
"@hyperlane-xyz/warp-metrics": minor
"@hyperlane-xyz/warp-monitor": patch
"@hyperlane-xyz/rebalancer": patch
---

Created new `@hyperlane-xyz/warp-metrics` package to deduplicate monitoring logic between warp-monitor and rebalancer. Extracted shared Prometheus gauge definitions, metric update functions, balance utilities, and types into the new package. Both warp-monitor and rebalancer now use the shared package, eliminating code duplication and ensuring consistent metric collection.
