---
'@hyperlane-xyz/sdk': minor
---

Add first-class `rebalanceTargets` support for `CrossCollateralRouter` warp configs (completing the SDK surface for #8894's `IRebalanceTargets`). The `crossCollateral` token config gains an optional `rebalanceTargets` map (domain/chain → target router addresses); `EvmWarpModule` diffs it and emits `addRebalanceTarget(uint32,bytes32)` / `removeRebalanceTarget(uint32,bytes32)` during `warp apply`, and `EvmWarpRouteReader` reads it back (across all domains including the local domain), so it round-trips idempotently.
