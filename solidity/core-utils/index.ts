export * from './typechain/index.js';
export * from './zksync/index.js';

// Re-export file-level Solidity struct types from individual typechain
// outputs. typechain generates per-contract .d.ts files with these types,
// but its own root index only re-exports contract/factory names. Hoist
// commonly-used struct types so SDK consumers can import them from
// '@hyperlane-xyz/core' without dipping into deep subpaths.
export type {
  DomainGasConfigStruct,
  DomainGasConfigStructOutput,
  GasParamStruct,
  GasParamStructOutput,
  TokenGasOracleConfigStruct,
  TokenGasOracleConfigStructOutput,
} from './typechain/contracts/hooks/igp/MinimalInterchainGasPaymaster.js';
export type {
  StoredGasQuoteStruct,
  StoredGasQuoteStructOutput,
} from './typechain/contracts/hooks/igp/OffchainQuotedIGP.js';

// GENERATED CODE - DO NOT EDIT
export const CONTRACTS_PACKAGE_VERSION = '11.3.1';
