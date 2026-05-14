---
"@hyperlane-xyz/cli": minor
"@hyperlane-xyz/sdk": minor
---

Added a new `hyperlane warp balances` CLI command that displays token balances for each leg of a warp route. Fixed `EvmHypRebaseCollateralAdapter.getBridgedSupply` to convert vault shares into underlying assets. Added `EvmHypOwnerCollateralAdapter` that reads `assetDeposited` directly from `HypERC4626OwnerCollateral`, and routed `WarpCore.getTokenCollateral` through `getBridgedSupply` for ERC4626 collateral standards so destination-collateral checks and balance display no longer report zero for yield-bearing vault routes.
