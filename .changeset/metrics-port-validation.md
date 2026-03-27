---
'@hyperlane-xyz/metrics': patch
---

Metrics server startup validated `PROMETHEUS_PORT` before listening and threw a clear error for empty, non-numeric, or out-of-range values.
