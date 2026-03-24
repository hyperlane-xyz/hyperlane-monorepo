---
'@hyperlane-xyz/rebalancer': minor
---

The ExplorerClient `toBytea` helper was updated to support multi-protocol addresses (Solana, Starknet, etc.) by resolving the chain's protocol type and delegating to `addressToByteHexString` for correct byte-length encoding.

**Note:** The `ExplorerClient` constructor signature changed from `(baseUrl)` to `(baseUrl, getProtocol)`. Consumers using the `IExplorerClient` interface are unaffected; direct instantiation of `ExplorerClient` must pass the new `getProtocol` parameter.
