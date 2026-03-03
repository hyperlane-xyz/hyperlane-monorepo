---
'@hyperlane-xyz/sdk': patch
---

The xERC20 lockbox adapter was updated to resolve the wrapped token address directly from the lockbox contract instead of the inherited collateral adapter, fixing `getBridgedSupply()` failures on older lockbox deployments.
