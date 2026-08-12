---
'@hyperlane-xyz/sdk': patch
---

The `collateralDex` registry token-type annotation (used by paradex collateral warp routes such as ETH/paradex and DIME/paradex) is now normalized to `TokenType.collateral` in the `HypTokenConfigSchema` preprocessor. Previously it fell through to `TokenType.unknown`, which false-flagged a `type` ConfigMismatch in check-warp-deploy against the on-chain-derived `collateral` type. The now-redundant `normalizeAltVmExpectedTokenType` helper was removed since the schema normalizes the annotation before the altVM diff runs.
