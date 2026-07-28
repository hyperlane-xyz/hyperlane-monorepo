---
'@hyperlane-xyz/sdk': patch
---

Updated `expandWarpDeployConfig` to canonicalize `allowedRebalancingBridges` keys to domain IDs, mirroring the treatment of `remoteRouters` and `destinationGas`. Previously a config keyed by chain name compared unequal to the domain-ID-keyed on-chain state and read as drift; now name-keyed and domain-ID-keyed configs compared equal. Keys resolving to the same canonical domain ID had their bridges merged by bridge identity — unioning `approvedTokens` — so a bridge listed under both a chain-name key and its domain-ID key no longer expanded to a duplicate that read as permanent drift against the deduplicated on-chain state.
