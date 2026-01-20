---
"@hyperlane-xyz/warp-monitor": patch
"@hyperlane-xyz/rebalancer": patch
"@hyperlane-xyz/infra": patch
"@hyperlane-xyz/ccip-server": patch
---

Migrated to use shared utilities from `@hyperlane-xyz/metrics` package, eliminating duplicate metric server implementations and ensuring consistent Prometheus metric collection across all services.
