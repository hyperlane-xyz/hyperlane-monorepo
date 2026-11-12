---
'@hyperlane-xyz/rebalancer': patch
---

Reported when a verified solid Tron receipt was already reflected in finalized balances while settlement still awaited configured confirmations. Propagated unavailable settlement verification so callers deferred stale balance decisions without releasing reservations.
