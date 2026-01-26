---
'@hyperlane-xyz/sdk': patch
'@hyperlane-xyz/cli': patch
---

Updated `proxyAdminUpdateTxs()` to respect `ownerOverrides.proxyAdmin` when determining the expected proxyAdmin owner. The priority is now: `ownerOverrides.proxyAdmin` > `proxyAdmin.owner` > `owner`.
