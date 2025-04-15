---
'@hyperlane-xyz/infra': minor
'@hyperlane-xyz/sdk': minor
---

The router enrollment check is enhanced to work non-fully connected warp routes.
It uses the `remoteRouters` property from the deployment config to get the list
of remote chains that should be enrolled.
