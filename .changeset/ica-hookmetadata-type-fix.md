---
'@hyperlane-xyz/sdk': minor
---

Added `estimateIcaHandleGas()` public method to estimate destination gas for ICA calls. `getCallRemote()` now extracts gasLimit from hookMetadata for accurate IGP quoting with the `quoteGasPayment(uint32,uint256)` overload. Fixed `hookMetadata` type from `BigNumber` to `string` in `GetCallRemoteSettings`.
