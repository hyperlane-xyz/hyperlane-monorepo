---
'@hyperlane-xyz/sdk': patch
---

Added a 30-second minimum floor to the dynamic confirmation timeout in `MultiProvider.handleTx`, preventing unreasonably short timeouts on fast L2 chains with very small `estimateBlockTime` values.
