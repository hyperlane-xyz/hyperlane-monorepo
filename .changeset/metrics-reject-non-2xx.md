---
'@hyperlane-xyz/metrics': patch
---

PushGateway error propagation was fixed to reject every non-2xx response, including redirects, so batch monitoring jobs no longer report successful stale metric pushes.
