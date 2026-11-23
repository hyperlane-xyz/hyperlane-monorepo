---
'@hyperlane-xyz/rebalancer': patch
'@hyperlane-xyz/rebalancer-sim': patch
---

Inventory movements were reserved before bridge submission and retained across ambiguous sends, cancellation statuses, and tracking expiry to prevent duplicate transfers. Proven pre-send failures remained retryable, and approval identities were tracked separately from primary transfers.
