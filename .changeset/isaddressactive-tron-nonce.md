---
"@hyperlane-xyz/sdk": patch
---

`isAddressActive` now checks contract code first and branches on chain protocol for the liveness fallback: EVM chains use the account nonce (`eth_getTransactionCount`), while Tron — whose JSON-RPC does not implement `eth_getTransactionCount` — uses a native balance probe. This stops Tron contract owners such as ICAs from being reported as Inactive without swallowing genuine RPC errors on real EVM chains.
