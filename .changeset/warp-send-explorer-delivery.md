---
'@hyperlane-xyz/cli': patch
'@hyperlane-xyz/aleo-sdk': patch
'@hyperlane-xyz/sdk': patch
---

Updated warp send to confirm delivery directly on each destination chain through the SDK. Added CosmWasm delivery polling and Starknet RPC failover for delivery reads, and fixed Aleo RPC encoding for structured delivery keys.
