---
'@hyperlane-xyz/sdk': patch
---

`SeismicSigner.sendTransaction` now fills a missing `gasLimit` from the signed-read gas estimate instead of letting the inner signer run an unsigned `eth_estimateGas`, which Seismic executes with `msg.sender = 0x0` and which therefore failed for every owner-gated write during `core deploy` and `warp deploy`.
