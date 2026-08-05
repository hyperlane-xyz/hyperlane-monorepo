---
"@hyperlane-xyz/sdk": patch
---

The EVM warp route check was updated to ignore nested immutable `LinearFee` sub-fee (per-destination) owners when comparing `tokenFee` configs. `normalizeTokenFeeForCheck` collapses nested `LinearFee` owners to a fixed sentinel on both sides of the diff — their only authority is `setFee`, and `bps` is already compared — so that owner drift no longer produces a `check-warp-deploy` violation. `OffchainQuotedLinearFee` sub-fee owners are still compared, since that owner additionally controls quote-signer management. The top-level RoutingFee owner (which controls `setFeeContract` routing and fee claiming), fee parameters, and `quoteSigners` are still compared normally.
