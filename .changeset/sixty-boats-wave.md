---
'@hyperlane-xyz/core': minor
'@hyperlane-xyz/sdk': patch
---

The TokenBridgeOft contract, LayerZero IOFT interface, and Forge tests were moved into the core Solidity package. The SDK was updated to resolve TokenBridgeOft factories from `@hyperlane-xyz/core`, and the deprecated `@hyperlane-xyz/multicollateral` package was removed.
