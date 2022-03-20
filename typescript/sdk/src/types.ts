import { ethers } from 'ethers';

/**
 * RPC Pagination information for Polygon
 */
export interface Pagination {
  blocks: number;
  from: number;
}

/**
 * The names of Abacus supported chains
 */
export type MainnetChainNames = 'celo' | 'ethereum' | 'avalanche' | 'polygon';
export type TestnetChainNames = 'alfajores' | 'mumbai' | 'kovan' | 'goerli' | 'fuji' | 'rinkarby' | 'rinkeby' | 'ropsten';
export type DevelopmentChainNames = 'local';
export type ChainName = MainnetChainNames | TestnetChainNames | DevelopmentChainNames;

/**
 * A Domain (and its characteristics)
 */
export interface Domain {
  id: number;
  name: ChainName;
  paginate?: Pagination;
}

export type Connection = ethers.providers.Provider | ethers.Signer;
