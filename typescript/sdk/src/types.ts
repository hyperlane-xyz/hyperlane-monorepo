import { types } from '@abacus-network/utils';
import { ethers } from 'ethers';

/**
 * RPC Pagination information for Polygon
 */
export interface Pagination {
  blocks: number;
  from: number;
}

/**
 * Enumeration of Abacus supported chains
 */
export enum Chains {
  alfajores,
  mumbai,
  kovan,
  goerli,
  fuji,
  rinkarby,
  rinkeby,
  ropsten,
  celo,
  ethereum,
  avalanche,
  polygon,
}
export type ChainName = keyof typeof Chains;
export type ChainMap<V> = Record<ChainName, V>;
export type ChainSubsetMap<K extends ChainName, V> = Record<K, V>;
export type Remotes<
  Networks extends ChainName,
  Local extends Networks,
> = Exclude<Networks, Local>;
export type RemoteChainSubsetMap<
  N extends ChainName,
  L extends N,
  V,
> = ChainSubsetMap<Remotes<N, L>, V>;

/**
 * A Domain (and its characteristics)
 */
export interface Domain {
  name: ChainName;
  id: number;
  nativeTokenDecimals?: number;
  paginate?: Pagination;
}

export type Connection = ethers.providers.Provider | ethers.Signer;

export type ProxiedAddress = {
  proxy: types.Address;
  implementation: types.Address;
  beacon: types.Address;
};

export type NameOrDomain = ChainName | number;
