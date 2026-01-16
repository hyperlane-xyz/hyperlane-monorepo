---
"@hyperlane-xyz/sdk": patch
---

Fix `RoutingFee` deployment when the configured owner differs from the deployer signer, and avoid requiring routing destinations when deriving `RoutingFee` configs during warp deploy.
