---
'@hyperlane-xyz/sdk': patch
---

expandWarpDeployConfig now canonicalizes allowedRebalancingBridges keys to domain IDs, mirroring the treatment of remoteRouters and destinationGas. Configs keyed by chain name and configs keyed by domain ID now compare equal, so name-keyed rebalancing bridges no longer read as drift against on-chain state.
