---
'@hyperlane-xyz/sdk': patch
---

Fixed two `WarpCore` issues for `QuotedCalls` flows:

- Updated `resolveQuotedCallsParams` to treat `EvmHypNative` routes as native (zero-address token) by also checking `isHypNative()`. Previously, native warp routers were misidentified — `getQuotedTransferFee` returned `msg.value` (transfer amount + fee) as the IGP quote, so UIs displayed the bridged amount itself as "Interchain Gas".
- Added an optional `quotedCalls` param to `getLocalTransferFee` and `getLocalTransferFeeAmount`, forwarded to `getTransferRemoteTxs`. Internal gas estimation now builds the actual `QuotedCalls.execute(...)` multicall instead of plain `transferRemote`, giving accurate pre-sign gas estimates for the QuotedCalls path. Callers were previously hardcoding `localQuote = 0`.
