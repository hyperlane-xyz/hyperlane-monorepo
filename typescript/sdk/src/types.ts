import { types } from '@abacus-network/utils';
import { ethers } from 'ethers';
import { domains } from './domains';

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
export type CompleteChainMap<Value> = Record<ChainName, Value>;
export type ChainMap<Networks extends ChainName, Value> = Record<
  Networks,
  Value
>;
export const AllChains = Object.keys(Chains) as ChainName[];
export const ChainIdToName: { [id: number]: ChainName } = Object.fromEntries(
  AllChains.map((chain) => [domains[chain].id, chain]),
);
// TODO: remove
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
