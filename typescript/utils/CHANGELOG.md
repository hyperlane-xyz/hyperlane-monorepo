# @hyperlane-xyz/utils

## 3.10.0

### Minor Changes

- 96485144a: SDK support for ICA deployment and operation.
- 4e7a43be6: Replace Debug logger with Pino

## 3.9.0

## 3.8.2

## 3.8.1

### Patch Changes

- 5daaae274: Prevent warp transfers to zero-ish addresses

## 3.8.0

### Minor Changes

- 9681df08d: Add `WarpCore`, `Token`, and `TokenAmount` classes for interacting with Warp Route instances.

  _Breaking change_: The params to the `IHypTokenAdapter` `populateTransferRemoteTx` method have changed. `txValue` has been replaced with `interchainGas`.

## 3.7.0

## 3.6.2

## 3.6.1

### Patch Changes

- 3c298d064: Add isAddress function to check if string matches EVM, Cosmos, or Solana address formats
- df24eec8b: Fix for address utils falsy fallbacks
- 78e50e7da: addressToBytes32 changed to work for all protocol types

## 3.6.0

## 3.5.1

## 3.5.0

## 3.4.0

### Patch Changes

- fd4fc1898: - Upgrade Viem to 1.20.0
  - Add optional restUrls field to ChainMetadata
  - Add deepCopy util function
  - Add support for cosmos factory token addresses

## 3.3.0

## 3.2.0

## 3.1.10
