---
"@hyperlane-xyz/sdk": patch
---

The EVM warp route check now ignores nested sub-fee (per-destination) owners when comparing `tokenFee` configs. `normalizeTokenFeeForCheck` collapses every nested `RoutingFee`/`CrossCollateralRoutingFee` sub-fee owner to a fixed sentinel on both sides of the diff, so sub-fee owner drift no longer produces a `check-warp-deploy` violation. The top-level RoutingFee owner (the only meaningful authority — it controls pricing via `setFeeContract` and fee claiming), fee parameters, and `quoteSigners` are still compared normally.
