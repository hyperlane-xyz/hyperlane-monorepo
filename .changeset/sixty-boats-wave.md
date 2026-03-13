---
'@hyperlane-xyz/core': minor
'@hyperlane-xyz/multicollateral': major
'@hyperlane-xyz/sdk': patch
---

The TokenBridgeOft contract, LayerZero IOFT interface, and Forge tests were moved into the core Solidity package. The SDK was updated to resolve TokenBridgeOft factories from `@hyperlane-xyz/core` instead of `@hyperlane-xyz/multicollateral`.
