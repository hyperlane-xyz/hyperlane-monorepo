# @hyperlane-xyz/utils

## 5.1.0

## 5.0.0

### Major Changes

- 488f949ef: Upgrade CosmJS libs to 0.32.4

### Minor Changes

- 388d25517: Added HyperlaneRelayer for relaying messages from the CLI
- dfa908796: set the errorMessage argument as required for assert util function

### Patch Changes

- 1474865ae: Replace `configDeepEquals` with improve `deepEquals`

## 4.1.0

## 4.0.0

## 3.16.0

## 3.15.1

## 3.15.0

## 3.14.0

## 3.13.0

### Minor Changes

- 0cf692e73: Implement metadata builder fetching from message

## 3.12.0

### Minor Changes

- 69de68a66: Implement aggregation and multisig ISM metadata encoding

## 3.11.1

## 3.11.0

### Minor Changes

- b63714ede: Convert all public hyperlane npm packages from CJS to pure ESM
- af2634207: Moved Hook/ISM config stringify into a general object stringify utility.

### Patch Changes

- 2b3f75836: Add objLength and isObjEmpty utils

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
