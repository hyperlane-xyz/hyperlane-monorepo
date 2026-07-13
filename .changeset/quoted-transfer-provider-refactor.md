---
"@hyperlane-xyz/sdk": minor
---

The EVM-specific offchain-quoting logic in `WarpCore` was extracted behind a protocol-agnostic `QuotedTransferProvider` interface. `EvmQuotedTransferProvider` took over what was previously inlined in `WarpCore.getQuotedCallsTransferTxs` + `resolveQuotedCallsParams` + `getQuotedTransferFee`, and `WarpCore.getTransferRemoteTxs` gained an optional `quotedTransfer?: QuotedTransferProvider` that supersedes the legacy `quotedCalls?: QuotedCallsParams` field (kept as backwards-compatible sugar that wraps into an `EvmQuotedTransferProvider`). No external behavior change — existing callers passing `quotedCalls` keep producing byte-identical txs, and `getQuotedTransferFee` still returns the same shape. The new interface is the dispatch hook that future protocol implementations (Sealevel offchain quoting) plug into.
