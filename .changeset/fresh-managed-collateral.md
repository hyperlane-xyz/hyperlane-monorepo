---
'@hyperlane-xyz/metrics': patch
'@hyperlane-xyz/rebalancer': patch
---

Reused the collateral address from the current managed-lockbox balance observation when reading token metadata, avoiding a duplicate contract lookup while retaining fresh metadata and standalone lookup behavior.
