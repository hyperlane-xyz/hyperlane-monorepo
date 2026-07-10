---
'@hyperlane-xyz/sdk': patch
---

`tryGetEvmExplorerMetadata` now restricts explorer-API usage to Etherscan-compatible families (Etherscan/Blockscout/Routescan/ZkSync) instead of only excluding `Other`, so non-Etherscan explorers such as TronScan are skipped cleanly instead of returning HTML that breaks JSON parsing during xERC20 bridge derivation (warp read / enrollment on Tron).
