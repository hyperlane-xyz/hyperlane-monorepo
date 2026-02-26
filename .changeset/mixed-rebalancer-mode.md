---
'@hyperlane-xyz/rebalancer': minor
---

Mixed rebalancer mode was added to enable simultaneous movable collateral (EVM) and inventory (Solana/multi-VM) execution within a single rebalancer config. The inventorySigner field was refactored to inventorySigners per-protocol map, LiFiBridge was extended with Solana support via KeypairWalletAdapter, and executeTransferRemote was refactored to use WarpCore.getTransferRemoteTxs for multi-VM compatibility.
