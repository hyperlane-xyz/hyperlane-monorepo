---
'@hyperlane-xyz/sdk': major
---

SVM token adapters were updated to support the on-chain fee flow: `quoteTransferRemoteGas` returns both warp-fee and IGP quotes when the route opts in, `populateTransferRemote(To)Tx` splices the fee + new-flow IGP sections into the account list, and transactions are compiled as `VersionedTransaction` with the registered Address Lookup Tables when `WarpCoreConfig.options.sealevel.altAddresses` is set. The exported `SolanaWeb3Transaction.transaction` field and the `SvmTransactionSigner.signTransaction` signature were widened from `Transaction` to `Transaction | VersionedTransaction`, a breaking change for consumers that call legacy-`Transaction`-only members without first narrowing the union.
