---
"@hyperlane-xyz/deploy-sdk": patch
---

`createHookReader` accepted an optional mailbox context, which was threaded through `AltVMCoreReader` and `WarpTokenReader` for SVM merkle tree hook detection.
