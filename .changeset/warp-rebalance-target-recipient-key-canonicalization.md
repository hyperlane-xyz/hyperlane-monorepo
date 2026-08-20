---
'@hyperlane-xyz/sdk': patch
---

Updated `expandWarpDeployConfig` to canonicalize `rebalanceTargets` and `rebalanceRecipients` keys to domain IDs on cross-collateral token configs, mirroring the treatment of `allowedRebalancingBridges`, `remoteRouters`, and `destinationGas`. Previously a config keyed by chain name compared unequal to the domain-ID-keyed on-chain state read by `EvmWarpRouteReader`, so the warp config checker reported a permanent false-positive `ConfigMismatch`; now name-keyed and domain-ID-keyed configs compare equal. Keys resolving to the same canonical domain ID have their rebalance targets unioned.
