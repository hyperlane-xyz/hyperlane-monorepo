import { ethers } from 'ethers';

import { types } from '@abacus-network/utils';

import { chainMetadata } from './chain-metadata';

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
export enum Chains { // must be string type to be used with Object.keys
  alfajores = 'alfajores',
  mumbai = 'mumbai',
  kovan = 'kovan',
  goerli = 'goerli',
  fuji = 'fuji',
  celo = 'celo',
  ethereum = 'ethereum',
  avalanche = 'avalanche',
  polygon = 'polygon',
  bsctestnet = 'bsctestnet',
  arbitrumrinkeby = 'arbitrumrinkeby',
  optimismkovan = 'optimismkovan',
  auroratestnet = 'auroratestnet',
  test1 = 'test1',
  test2 = 'test2',
  test3 = 'test3',
}
export type ChainName = keyof typeof Chains;
export type CompleteChainMap<Value> = Record<ChainName, Value>;
export type ChainMap<Networks extends ChainName, Value> = Record<
  Networks,
  Value
>;

export type TestChainNames = 'test1' | 'test2' | 'test3';

export const AllChains = Object.keys(Chains) as ChainName[];
export const DomainIdToChainName = Object.fromEntries(
  AllChains.map((chain) => [chainMetadata[chain].id, chain]),
);
export const ChainNameToDomainId = Object.fromEntries(
  AllChains.map((chain) => [chain, chainMetadata[chain].id]),
) as CompleteChainMap<number>;
export type NameOrDomain = ChainName | number;

export type Remotes<
  Networks extends ChainName,
  Local extends Networks,
> = Exclude<Networks, Local>;

export type RemoteChainMap<
  Networks extends ChainName,
  Local extends Networks,
  Value,
> = Record<Remotes<Networks, Local>, Value>;

/**
 * A Domain (and its characteristics)
 */
export type ChainMetadata = {
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
