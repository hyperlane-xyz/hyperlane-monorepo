---
'@hyperlane-xyz/sdk': patch
---

The warp-route `ownerStatus` check no longer bakes governance-ICA knowledge into the SDK. `expandWarpDeployConfig` is now deterministic (an Inactive owner is normalized to Active), and `checkWarpRouteDeployConfig` accepts an optional `acceptedInactiveOwners` list of `{ chain, owner }` verdicts. An observed Inactive owner is treated as acceptable only when the exact `{ chain, owner }` pair is present in that list, letting the caller (infra) own the governance decision of deriving and verifying the ICA while the SDK stays governance-agnostic.
