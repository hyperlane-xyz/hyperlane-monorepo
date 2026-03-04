---
'@hyperlane-xyz/sdk': minor
'@hyperlane-xyz/cli': minor
'@hyperlane-xyz/warp-monitor': minor
---

MultiCollateral warp route support was added across the SDK, CLI, and warp monitor.

SDK: WarpCore gained `transferRemoteTo` flows for multicollateral tokens, including fee quoting, ERC-20 approval, and destination token resolution. EvmWarpModule now handles multicollateral router enrollment/unenrollment with canonical router ID normalization. EvmWarpRouteReader derives multicollateral token config including on-chain scale. A new `EvmMultiCollateralAdapter` provides quote, approve, and transfer operations.

CLI: `warp deploy` and `warp extend` support multicollateral token types. A new `warp combine` command merges independent warp route configs into a single multicollateral route. `warp send` and `warp check` work with multicollateral routes.

Warp monitor: Pending-transfer and inventory metrics were added for multicollateral routes, with projected deficit scoped to collateralized routes only.
