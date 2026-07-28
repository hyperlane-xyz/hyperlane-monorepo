---
'@hyperlane-xyz/sdk': patch
---

The altVM warp check no longer reports a false-positive `decimals` ConfigMismatch on native legs whose on-chain reader resolves a concrete decimals value (e.g. Sealevel/Solana native = 9). The expected side omits decimals for altVM native tokens, so `buildAltVmWarpRouteDiff` now skips the decimals comparison whenever the deploy config omits it, mirroring the existing ISM/hook/contractVersion handling.
