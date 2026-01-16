---
'@hyperlane-xyz/cli': minor
---

Added multi-VM support to `hyperlane warp send` command. The command now supports transfers across all WarpCore-supported VMs including EVM, Sealevel (Solana), Cosmos, CosmosNative, Starknet, and Radix. Non-EVM destinations use Explorer GraphQL polling for delivery verification with automatic fallback to on-chain polling. Self-relay is only supported for EVM destinations and will warn/skip otherwise.
