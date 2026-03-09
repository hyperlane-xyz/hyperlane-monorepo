---
'@hyperlane-xyz/multicollateral': minor
'@hyperlane-xyz/sdk': patch
---

`quoteTransferRemoteTo` was fixed to work without a default `Router._routers` enrollment by adding a target-router-aware gas quote helper. `setDestinationGasForDomain` and `setDestinationGasForDomains` were added to allow setting destination gas for MC-enrolled-only domains that bypass `GasRouter._setDestinationGas`. Authorization checks were deduplicated into `_requireAuthorizedRouter`. SDK EvmWarpRouteReader was updated to include MC-enrolled domains when reading destination gas, and EvmWarpModule was updated to use the MC-specific gas setter with correct transaction ordering.
