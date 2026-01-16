---
"@hyperlane-xyz/ccip-server": patch
"@hyperlane-xyz/metrics": patch
---

Migrated ccip-server to use the shared `startMetricsServer` from `@hyperlane-xyz/metrics`. This eliminates the duplicate Express-based metrics server implementation and ensures consistent behavior across all services. The shared server now uses `register.contentType` for proper Prometheus content type headers.
