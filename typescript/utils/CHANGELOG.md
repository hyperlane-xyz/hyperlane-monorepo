# @hyperlane-xyz/utils

## 12.6.1-next.0

## 12.6.0

### Minor Changes

- d182d7d: Adds the sortArraysInObject function to properly sort arrays in an object recursively given an optional sort function
- b360802: Add the isCosmosIbcDenomAddress function and improve the config expasion logic to correctly format the destination gas

## 12.5.0

## 12.4.0

## 12.3.0

### Minor Changes

- 7500bd6fe: implemented cosmos protocol type and cosmos token adapter

## 12.2.0

## 12.1.0

## 12.0.0

## 11.0.0

### Major Changes

- 3b060c3e1: Stub new CosmosModule ProtocolType.

## 10.0.0

### Minor Changes

- b8d95fc95: implement custom ESLint rule for restricted imports from exports

## 9.2.1

## 9.2.0

## 9.1.0

## 9.0.0

### Major Changes

- 4df37393f: Added minimal support for Starknet networks (for successful registry build)

## 8.9.0

### Minor Changes

- 05f89650b: Added utils for fetching extra lockboxes data from a xERC20 warp route
- 3518f8901: Add ZERO_ADDRESS_HEX_32 constant.

## 8.8.1

## 8.8.0

## 8.7.0

## 8.6.1

## 8.6.0

## 8.5.0

## 8.4.0

## 8.3.0

## 8.2.0

## 8.1.0

## 8.0.0

### Minor Changes

- 79f8197f3: Added `isPrivateKeyEvm` function for validating EVM private keys

### Patch Changes

- 8834a8c92: Require concurrency > 0 for concurrentMap

## 7.3.0

## 7.2.0

### Minor Changes

- fa6d5f5c6: Add toUpperCamelCase and deepFind functions

## 7.1.0

### Minor Changes

- 0e285a443: Add an isRelativeUrl function

## 7.0.0

### Major Changes

- f48cf8766: Upgrade Viem to 2.2 and Solana Web3 to 1.9
  Rename `chainMetadataToWagmiChain` to `chainMetadataToViemChain`

### Patch Changes

- e6f9d5c4f: Added a mustGet helper

## 6.0.0

### Major Changes

- e3b97c455: Detangle assumption that chainId == domainId for EVM chains. Domain IDs and Chain Names are still unique, but chainId is no longer guaranteed to be a unique identifier. Domain ID is no longer an optional field and is now required for all chain metadata.

## 5.7.0

### Patch Changes

- e104cf6aa: Dedupe internals of hook and ISM module deploy code
- 04108155d: fix median utils func + add test
- 39a9b2038: Filter undefined/null values in invertKeysAndValues function

## 5.6.2

### Patch Changes

- 5fd4267e7: Supported non-32 byte non-EVM recipients when sending warps from Sealevel
- a36fc5fb2: fix: isObject utils fn should return only boolean value

## 5.6.1

## 5.6.0

### Minor Changes

- 29341950e: Adds new `core check` command to compare local configuration and on chain deployments. Adds memoization to the EvmHookReader to avoid repeating configuration derivation

### Patch Changes

- f1712deb7: Fix objMerge implementation

## 5.5.0

### Minor Changes

- 2afc484a2: Migrate fetchWithTimeout from widgets to utils
  Add objSlice function and improve types for objMerge
  Add isUrl function

## 5.4.0

### Minor Changes

- 4415ac224: Add Gnosis safe transaction builder to warp apply

## 5.3.0

### Minor Changes

- 746eeb9d9: Add parseTokenMessage util for decoding warp route transfers

### Patch Changes

- 50319d8ba: Ensure runWithTimeout cleans up after itself properly

## 5.2.1

## 5.2.0

### Minor Changes

- d6de34ad5: Add sortArraysInConfig method, normalizeConfig implementation to call sortArraysInConfig after current behavior
- 291c5fe36: Add addBufferToGasLimit for gas limit buffer calculations

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
