---
"@hyperlane-xyz/sdk": patch
---

The EVM warp route check now derives cross-collateral-routing (CCR) fee entries for every enrolled router key, not just the multi-collateral-enrolled subset. Previously `EvmWarpRouteReader` only seeded fee-mapping keys from on-chain `crossCollateralRouters` plus the default router key, so any `feeContracts` entry keyed under a normal `remoteRouters` address — including the local domain's own router for same-chain swaps — was never read, producing perpetual false-positive `tokenFee` violations in `check-warp-deploy`. The reader now unions `crossCollateralRouters`, `remoteRouters`, and the local router's own address when probing fee contracts.
