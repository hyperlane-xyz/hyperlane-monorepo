---
'@hyperlane-xyz/radix-sdk': patch
---

Increased Radix transaction epoch validity window from 2 to 10 epochs to prevent `TransactionEpochNoLongerValid` flakes in CI.
