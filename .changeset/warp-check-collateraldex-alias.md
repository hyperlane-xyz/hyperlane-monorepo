---
"@hyperlane-xyz/sdk": patch
---

Updated the altVM warp route check to treat the paradex-only `collateralDex` registry annotation as equivalent to `collateral`. `collateralDex` has no matching SDK `TokenType`, and on-chain the leg is a standard collateral router, so the deriver reported `collateral` and the generic altVM diff produced a perpetual false-positive `type` ConfigMismatch in `check-warp-deploy` for the ETH/paradex and DIME/paradex routes.
