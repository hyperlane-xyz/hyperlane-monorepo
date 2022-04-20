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
export type ChainMap<Value> = Record<ChainName, Value>;
export type ChainSubsetMap<Networks extends ChainName, Value> = Record<
  Networks,
  Value
>;
export type Remotes<
  Networks extends ChainName,
  Local extends Networks,
> = Exclude<Networks, Local>;
export type RemoteChainSubsetMap<
  Networks extends ChainName,
  Local extends Networks,
  Value,
> = Record<Remotes<Networks, Local>, Value>;

/**
 * A Domain (and its characteristics)
 */
export type Domain = {
  id: number;
  nativeTokenDecimals?: number;
  paginate?: Pagination;
};

export type Connection = ethers.providers.Provider | ethers.Signer;

export type ProxiedAddress = {
  proxy: types.Address;
  implementation: types.Address;
  beacon: types.Address;
};
