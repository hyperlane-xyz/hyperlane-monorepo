---
"@hyperlane-xyz/rebalancer": patch
---

Used the provider-owned bounded receipt waiter for ERC20 approvals so timed-out transactions no longer retained background listeners. Reverted approval receipts were rejected.
