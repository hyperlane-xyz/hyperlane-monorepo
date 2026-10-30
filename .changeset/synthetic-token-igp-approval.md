---
'@hyperlane-xyz/sdk': patch
---

Synthetic warp adapters were updated to check router allowances when a token-paid fee hook was configured. Direct synthetic approvals no longer required resetting nonzero allowances. Burn-only transfers, legacy routers, and Predicate wrapper approvals retained their existing behavior.
