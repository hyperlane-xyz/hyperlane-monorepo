---
'@hyperlane-xyz/rebalancer': patch
---

Reused the transfer gas quote within native-token cost estimation, avoiding a duplicate quote request while preserving fee reservations and standalone estimation behavior.
