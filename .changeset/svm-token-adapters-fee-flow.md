---
'@hyperlane-xyz/sdk': patch
---

SVM token adapters were updated to support the on-chain fee flow: `quoteTransferRemoteGas` returns both warp-fee and IGP quotes when the route opts in, `populateTransferRemote(To)Tx` splices the fee + new-flow IGP sections into the account list, and transactions are compiled as `VersionedTransaction` with the registered Address Lookup Tables when `WarpCoreConfig.options.sealevel.altAddresses` is set. `SolTransaction` was widened to `Transaction | VersionedTransaction`; downstream wallet adapters already accept this union, so external consumers require no changes.
