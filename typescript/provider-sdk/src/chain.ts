import { ChainId, Domain } from '@hyperlane-xyz/utils';

type ChainNameOrId = string | number;

/**
 * Consolidated chain metadata interface for all AltVM modules.
 * Contains the union of all fields needed by Core, ISM, Hook, and Warp modules.
 * Matches the subset of ChainMetadata that AltVM modules actually need.
 */
export interface ChainMetadataForAltVM {
  name: string;
  bech32Prefix?: string;
  domainId: Domain;
  chainId: ChainId;
  nativeToken?: {
    decimals?: number;
    denom?: string;
    symbol: string;
    name: string;
  };
  blocks?: {
    confirmations?: number;
    estimateBlockTime?: number;
  };
  rpcUrls?: {
    http: string;
  }[];
  gatewayUrls?: {
    http: string;
  }[];
  // Used in radix tests after deploying
  // the package address to the local chain
  packageAddress?: string;
}

/**
 * Test chain metadata type with additional fields for testing
 */
export interface TestChainMetadata extends ChainMetadataForAltVM {
  rpcPort: number;
  rpcUrl: string;
  restPort: number;
  gnosisSafeTransactionServiceUrl?: string;
}

/**
 * Function adapters for chain metadata lookups required by AltVM modules.
 * These provide a lightweight alternative to ChainMetadataManager and MultiProvider.
 */
export type ChainMetadataLookup = (
  chain: ChainNameOrId,
) => ChainMetadataForAltVM;

export type ChainNameLookup = (domainId: Domain) => string | null;

export type DomainIdLookup = (chain: ChainNameOrId) => Domain | null;

export type GetKnownChainNames = () => string[];

/**
 * Combined interface for all chain lookup operations.
 * Pass this instead of individual function adapters for cleaner signatures.
 */
export interface ChainLookup {
  getChainMetadata: ChainMetadataLookup;
  getChainName: ChainNameLookup;
  getDomainId: DomainIdLookup;
  getKnownChainNames: GetKnownChainNames;
}
