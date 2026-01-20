---
'@hyperlane-xyz/sdk': minor
---

Removed `refundAddress` from `GetCallRemoteSettings` type. Callers should now build `hookMetadata` themselves using `formatStandardHookMetadata()` from `@hyperlane-xyz/utils` and pass it to `getCallRemote()`. Added `estimateIcaHandleGas()` as a public method for callers to estimate gas before building metadata.
