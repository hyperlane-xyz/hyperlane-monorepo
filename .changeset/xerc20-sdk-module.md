---
"@hyperlane-xyz/sdk": major
---

Added EvmXERC20Reader and EvmXERC20Module for XERC20 limit and bridge management following HyperlaneModule pattern. Supported both Standard and Velodrome XERC20 types with on-chain bridge enumeration and drift detection.

BREAKING CHANGE: `deriveXERC20TokenType` signature changed from `(provider, address)` to `(multiProvider, chain, address)` to use SDK's `isContractAddress` utility.
