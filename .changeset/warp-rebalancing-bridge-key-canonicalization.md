---
'@hyperlane-xyz/sdk': patch
---

Updated `expandWarpDeployConfig` to canonicalize `allowedRebalancingBridges` keys to domain IDs, mirroring the treatment of `remoteRouters` and `destinationGas`. Previously a config keyed by chain name compared unequal to the domain-ID-keyed on-chain state and read as drift; now name-keyed and domain-ID-keyed configs compared equal. Keys resolving to the same canonical domain ID had their bridge lists merged rather than overwritten.
