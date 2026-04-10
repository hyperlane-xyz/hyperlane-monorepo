---
'@hyperlane-xyz/cli': minor
'@hyperlane-xyz/sdk': minor
'@hyperlane-xyz/sealevel-sdk': patch
'@hyperlane-xyz/provider-sdk': minor
---

Enabled SVM cross-collateral token deployments in the CLI. Added `crossCollateral` to supported Alt-VM token types, allowing `warp deploy`, `warp combine`, and `warp apply` to work with SVM CC routes. Extracted `computeCrossCollateralRouterUpdates` into provider-sdk for cross-protocol reuse. Fixed CC-only gas preservation for domains transitioning from remote routers.
