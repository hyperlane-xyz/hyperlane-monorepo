---
"@hyperlane-xyz/metrics": minor
"@hyperlane-xyz/warp-monitor": patch
"@hyperlane-xyz/rebalancer": patch
"@hyperlane-xyz/infra": patch
---

Created new `@hyperlane-xyz/metrics` package to consolidate Prometheus metric utilities across the monorepo. Extracted shared gauge definitions, metric update functions, balance utilities, server utilities, and types from warp-monitor, rebalancer, and infra into the new package. This eliminates code duplication and ensures consistent metric collection across all services.
