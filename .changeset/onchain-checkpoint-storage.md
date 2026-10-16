---
"@hyperlane-xyz/sdk": patch
---

On-chain checkpoint storage contract and validator configuration support were added. The contract (`OnchainCheckpointStorage.sol`) provides permissionless checkpoint storage with size limits and events. The Rust adapter (`OnchainStorage`) adds the `onchain://chain/contract` URL parsing and `CheckpointSyncerConf::Onchain` configuration variant. Provider injection, signer integration, RPC reads, and direct contract writes remain pending for full runtime integration.
