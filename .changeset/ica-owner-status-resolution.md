---
'@hyperlane-xyz/sdk': patch
---

The warp-route `ownerStatus` check no longer baked governance-ICA knowledge into the SDK. `expandWarpDeployConfig` became deterministic (an Inactive owner is normalized to Active), and `checkWarpRouteDeployConfig` gained an optional `acceptedInactiveOwners` list of `{ chain, owner }` verdicts. An observed Inactive owner was treated as acceptable only when the exact `{ chain, owner }` pair was present in that list, letting the caller (infra) own the governance decision of deriving and verifying the ICA while the SDK stayed governance-agnostic.
