---
'@hyperlane-xyz/rebalancer': minor
---

The ExplorerClient `toBytea` helper was updated to support multi-protocol addresses (Solana, Starknet, etc.) by resolving the chain's protocol type and delegating to `addressToByteHexString` for correct byte-length encoding.
