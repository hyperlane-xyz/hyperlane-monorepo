---
"@hyperlane-xyz/sdk": major
---

The EVM-specific offchain-quoting logic in `WarpCore` was extracted behind a protocol-agnostic `QuotedTransferProvider` interface. `EvmQuotedTransferProvider` took over what was previously inlined in `WarpCore.getQuotedCallsTransferTxs` + `resolveQuotedCallsParams` + `getQuotedTransferFee`, and `WarpCore.getTransferRemoteTxs` gained an optional `quotedTransfer?: QuotedTransferProvider` that supersedes the legacy `quotedCalls?: QuotedCallsParams` field (kept as backwards-compatible sugar that wraps into an `EvmQuotedTransferProvider`). Existing callers passing `quotedCalls` keep producing byte-identical txs, and the public `getQuotedTransferFee` still returns the same shape. The new interface is the dispatch hook that future protocol implementations (Sealevel offchain quoting) plug into.

**Breaking:** the `protected` methods `WarpCore.resolveQuotedCallsParams` and `WarpCore.getQuotedCallsTransferTxs` were removed — their logic now lives on `EvmQuotedTransferProvider`. There are no in-repo callers, but downstream `WarpCore` subclasses that referenced either method should instead pass a `quotedTransfer`/`quotedCalls` argument to `getTransferRemoteTxs` (or call the public `getQuotedTransferFee`), which route through the provider.
