---
'@hyperlane-xyz/sdk': patch
---

Fix two `WarpCore` issues for `QuotedCalls` flows:

- `resolveQuotedCallsParams` now treats `EvmHypNative` routes as native (zero-address token) by also checking `isHypNative()`. Previously, native warp routers were misidentified — `getQuotedTransferFee` returned `msg.value` (transfer amount + fee) as the IGP quote, so UIs displayed the bridged amount itself as "Interchain Gas".
- `getLocalTransferFee` and `getLocalTransferFeeAmount` accept an optional `quotedCalls` param and forward it to `getTransferRemoteTxs`. Internal gas estimation now builds the actual `QuotedCalls.execute(...)` multicall instead of plain `transferRemote`, giving accurate pre-sign gas estimates for the QuotedCalls path. Callers were previously hardcoding `localQuote = 0`.
