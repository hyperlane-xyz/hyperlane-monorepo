---
'@hyperlane-xyz/sdk': minor
---

An optional `options` parameter was added to `sendAndConfirmTransaction()` on `IMultiProtocolSigner`, reusing `SendTransactionOptions` from `MultiProvider`. The EVM adapter passes options (including `waitConfirmations`) directly through to `MultiProvider.sendTransaction()`. Other protocol adapters accept but ignore the parameter. This is a non-breaking change.
