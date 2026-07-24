---
'@hyperlane-xyz/metrics': patch
---

An opt-in `throwOnError` option was added to `submitMetrics` so batch/CronJob callers can fail loudly when a PushGateway push errors or returns a non-2xx status instead of silently recording a successful run.
