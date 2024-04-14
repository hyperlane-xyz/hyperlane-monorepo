import { Address } from '@hyperlane-xyz/utils';

import type { ChainMetadata } from '../metadata/chainMetadataTypes.js';
import type { ChainMap, ChainName } from '../types.js';

export type ChainAddresses = Record<string, Address>;

export interface IRegistry {
  getChains(): Promise<Array<ChainName>>;
  getMetadata(): Promise<ChainMap<ChainMetadata>>;
  getChainMetadata(chainName: ChainName): Promise<ChainMetadata | null>;
  getAddresses(): Promise<ChainMap<ChainAddresses>>;
  getChainAddresses(chainName: ChainName): Promise<ChainAddresses | null>;
  // TODO: Define write-related methods
}
