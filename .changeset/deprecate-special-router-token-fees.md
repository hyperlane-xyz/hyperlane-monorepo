---
"@hyperlane-xyz/core": patch
"@hyperlane-xyz/sdk": patch
---

Token fee support was disabled for ERC4626, fiat token, xERC20, and xERC20 lockbox routers. Configured token fees caused quotes and outbound transfers to revert until the fee recipient was removed. The SDK rejected unsupported token fee deployments and fee hooks on incompatible router types, including when fee hook update transactions were built directly, rejected adding token fees to xERC20 and xERC20 lockbox routers without an existing fee regardless of the requested contract version, allowed existing fees on those routers to be updated or removed, and required fee removal before upgrading them.
