---
'@hyperlane-xyz/multicollateral': minor
'@hyperlane-xyz/sdk': patch
'@hyperlane-xyz/core': patch
---

`quoteTransferRemoteTo` was fixed to work without a default `Router._routers` enrollment by adding a target-router-aware gas quote helper. `GasRouter._setDestinationGas` was made virtual and overridden in MultiCollateral to accept MC-enrolled-only domains, keeping the existing `setDestinationGas` function selector working for all domain types. Authorization checks were deduplicated into `_requireAuthorizedRouter`. SDK EvmWarpRouteReader was updated to include MC-enrolled domains when reading destination gas.
