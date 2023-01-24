import type { ethers } from 'ethers';

import type { ChainName } from './consts/chains';

// Re-export ChainName for convenience
export { ChainName };
// A full object map of all chains to a value type
export type CompleteChainMap<Value> = Record<ChainName, Value>;
export type LooseChainMap<Value> = Record<ChainName | string, Value>;
// A partial object map of some chains to a value type
export type PartialChainMap<Value> = Partial<CompleteChainMap<Value>>;
// A map of some specific subset of chains to a value type
export type ChainMap<Chain extends ChainName, Value> = Record<Chain, Value>;
// The names of test chains, should be kept up to date if new are added
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
  id: number;
  provider: ethers.providers.Provider;
  signer?: ethers.Signer;
  overrides?: ethers.Overrides;
  confirmations?: number;
  blockExplorerUrl?: string;
  blockExplorerApiUrl?: string;
}
