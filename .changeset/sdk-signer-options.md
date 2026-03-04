---
'@hyperlane-xyz/sdk': minor
---

An optional `options` parameter was added to `sendAndConfirmTransaction()` on `IMultiProtocolSigner`. The EVM adapter passes `waitConfirmations` through to `MultiProvider.sendTransaction()`. Other protocol adapters accept but ignore the parameter. This is a non-breaking change.
