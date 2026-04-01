---
'@hyperlane-xyz/sdk': patch
'@hyperlane-xyz/cli': patch
---

User-specified remoteRouters and destinationGas in warp deploy configs were ignored during router enrollment when the remote chains were not part of the deployment. enrollCrossChainRouters now merges user-specified entries with auto-discovered routers from deployed contracts.
