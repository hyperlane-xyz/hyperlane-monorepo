import type { ethers } from 'ethers';

import type { CoreChainName } from './consts/chains';

// Re-export ChainName for convenience
export { CoreChainName };
// An alias for string to clarify type is a chain name
export type ChainName = string;
// A full object map of all chains to a value type
export type CompleteChainMap<Value> = Record<ChainName, Value>;
// A map of chain names to a value type
export type ChainMap<Value> = Record<string, Value>;
// The names of test chains, should be kept up to date if new are added
export type TestChainNames = 'test1' | 'test2' | 'test3';

export type NameOrDomain = ChainName | number;

export type Connection = ethers.providers.Provider | ethers.Signer;
