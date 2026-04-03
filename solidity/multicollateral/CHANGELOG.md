# @hyperlane-xyz/multicollateral

## 1.0.2

### Patch Changes

- Updated dependencies [77db719]
    - @hyperlane-xyz/core@11.1.1

## 1.0.1

### Patch Changes

- Updated dependencies [6c715a7]
    - @hyperlane-xyz/core@11.1.0

## 1.0.0

### Major Changes

- b9c6844: MultiCollateral contracts and SDK/CLI terminology were renamed to CrossCollateral.

    The Solidity ABI was updated with renamed contracts, interfaces, router enrollment methods, domain/route getters, fee-quote method, events, and revert prefixes.

    The SDK token type was migrated to `crossCollateral`.

    Reader compatibility for legacy deployed contracts was not retained; readers now require the renamed CrossCollateral ABI methods.

### Patch Changes

- Updated dependencies [a4a74d8]
    - @hyperlane-xyz/core@11.0.3

## 0.2.0

### Minor Changes

- f7ebf6c: `quoteTransferRemoteTo` was fixed to work without a default `Router._routers` enrollment by adding a target-router-aware gas quote helper. `GasRouter._setDestinationGas` was made virtual and overridden in CrossCollateralRouter to accept MC-enrolled-only domains, keeping the existing `setDestinationGas` function selector working for all domain types. Authorization checks were deduplicated into `_requireAuthorizedRouter`. SDK EvmWarpRouteReader was updated to include MC-enrolled domains when reading destination gas.

### Patch Changes

- Updated dependencies [f7ebf6c]
    - @hyperlane-xyz/core@11.0.2

## 0.1.0

### Minor Changes

- d261bdf: The multicollateral package was promoted to a publishable contracts package with generated typechain factory exports for SDK integration.

### Patch Changes

- @hyperlane-xyz/core@11.0.1
