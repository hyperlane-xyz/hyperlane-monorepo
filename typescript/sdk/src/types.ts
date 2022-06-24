import type { ethers } from 'ethers';

import type { types } from '@abacus-network/utils';

import type { Chains } from './consts/chains';

declare global {
  type Address = types.Address;
}

export type ChainName = keyof typeof Chains;
export type CompleteChainMap<Value> = Record<ChainName, Value>;
export type ChainMap<Chain extends ChainName, Value> = Record<Chain, Value>;
export type TestChainNames = 'test1' | 'test2' | 'test3';

export type NameOrDomain = ChainName | number;

export type Remotes<
  Chain extends ChainName,
  LocalChain extends Chain,
> = Exclude<Chain, LocalChain>;

export type RemoteChainMap<
  Chain extends ChainName,
  LocalChain extends Chain,
  Value,
> = Record<Remotes<Chain, LocalChain>, Value>;

export type Connection = ethers.providers.Provider | ethers.Signer;

export interface IChainConnection {
  provider: ethers.providers.Provider;
  signer?: ethers.Signer;
  overrides?: ethers.Overrides;
  confirmations?: number;
  blockExplorerUrl?: string;
}
