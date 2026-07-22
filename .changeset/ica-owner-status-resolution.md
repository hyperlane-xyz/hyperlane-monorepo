---
'@hyperlane-xyz/sdk': patch
---

The warp-route `ownerStatus` check no longer reports an Inactive false positive for governance ICA owners on nonce-less / lazily-deployed chains (Tron and other AltVM). `expandWarpDeployConfig` and `checkWarpRouteDeployConfig` now accept an optional `interchainAccount`; when supplied, an Inactive owner is resolved by deriving the leaf-chain ICA from the route's Ethereum-leg owner and is treated as acceptable only when that derivation matches the on-chain owner and the origin owner is a Safe with threshold > 1, preserving the anti-1-of-1 signal.
