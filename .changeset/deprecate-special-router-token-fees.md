---
"@hyperlane-xyz/core": patch
"@hyperlane-xyz/sdk": patch
---

Token fee support was disabled for ERC4626, fiat token, xERC20, and xERC20 lockbox routers. The SDK rejected unsupported token fee deployments and fee hooks on incompatible router types, retained configuration compatibility for existing xERC20 routes, and required fee removal before upgrading them.
