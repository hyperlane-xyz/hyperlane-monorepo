---
'@hyperlane-xyz/sdk': patch
---

`MultiProvider.handleTx` was updated to return an included receipt for successful transactions when zero confirmations are configured, without waiting for ethers' default confirmation polling interval.
