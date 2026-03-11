# @hyperlane-xyz/multicollateral

## 0.2.0

### Minor Changes

- f7ebf6c: `quoteTransferRemoteTo` was fixed to work without a default `Router._routers` enrollment by adding a target-router-aware gas quote helper. `GasRouter._setDestinationGas` was made virtual and overridden in MultiCollateral to accept MC-enrolled-only domains, keeping the existing `setDestinationGas` function selector working for all domain types. Authorization checks were deduplicated into `_requireAuthorizedRouter`. SDK EvmWarpRouteReader was updated to include MC-enrolled domains when reading destination gas.

### Patch Changes

- Updated dependencies [f7ebf6c]
    - @hyperlane-xyz/core@11.0.2

## 0.1.0

### Minor Changes

- d261bdf: The multicollateral package was promoted to a publishable contracts package with generated typechain factory exports for SDK integration.

### Patch Changes

- @hyperlane-xyz/core@11.0.1
