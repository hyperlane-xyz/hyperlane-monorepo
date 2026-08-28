---
"@hyperlane-xyz/rebalancer": patch
---

Deferred execution until a fresh monitor snapshot after tracker settlement changes. Prevented inventory movements from being duplicated when delivery completed after the cycle balance sample, and deferred execution when tracker synchronization failed.
