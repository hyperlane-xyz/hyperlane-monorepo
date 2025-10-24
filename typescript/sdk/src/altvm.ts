import { Domain } from '@hyperlane-xyz/utils';

import { ChainNameOrId } from './types.js';

/**
 * Minimal base chain metadata required by all AltVM modules
 */
export interface ChainMetadataBase {
  name: string;
}

/**
 * Function adapters for chain metadata lookups required by AltVM modules.
 * These provide a lightweight alternative to ChainMetadataManager and MultiProvider.
 */
export type ChainMetadataLookup<
  T extends ChainMetadataBase = ChainMetadataBase,
> = (chain: ChainNameOrId) => T;

export type ChainNameLookup = (domainId: Domain) => string | null;

export type DomainIdLookup = (chain: ChainNameOrId) => Domain | null;

export type GetKnownChainNames = () => string[];

/**
 * Combined interface for all chain lookup operations.
 * Pass this instead of individual function adapters for cleaner signatures.
 */
export interface ChainLookup<T extends ChainMetadataBase = ChainMetadataBase> {
  getChainMetadata: ChainMetadataLookup<T>;
  getChainName: ChainNameLookup;
  getDomainId: DomainIdLookup;
  getKnownChainNames: GetKnownChainNames;
}
