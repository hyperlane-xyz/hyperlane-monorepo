---
'@hyperlane-xyz/multicollateral': minor
'@hyperlane-xyz/sdk': patch
---

Added `setDestinationGasForDomain` and `setDestinationGasForDomains` to MultiCollateral contract, allowing destination gas to be set for MC-enrolled-only domains that bypass the standard `Router._routers` enrollment. Updated SDK EvmWarpRouteReader to include MC-enrolled domains when reading destination gas, and updated EvmWarpModule to use the new MC-specific gas setter with correct transaction ordering (MC enrollment before gas setting).
