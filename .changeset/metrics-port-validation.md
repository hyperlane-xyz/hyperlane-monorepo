---
'@hyperlane-xyz/metrics': patch
---

Fixed metrics server startup to validate `PROMETHEUS_PORT` before listening and throw a clear error for empty, non-numeric, or out-of-range values.
