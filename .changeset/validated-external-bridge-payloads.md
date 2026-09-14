---
'@hyperlane-xyz/rebalancer': patch
---

External bridge calldata and Solana instruction validation were bound to supported bridge operations before signing. Unknown operations were rejected explicitly. LiFi submission observations and incomplete inventory polls were handled conservatively to prevent duplicate work after uncertain sends or stale balances.
