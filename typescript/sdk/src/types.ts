import type { ethers } from 'ethers';

import type { ChainId, Domain } from '@hyperlane-xyz/utils';

// An alias for string to clarify type is a chain name
export type ChainName = string;
// A map of chain names to a value type
export type ChainMap<Value> = Record<string, Value>;
// The names of test chains, should be kept up to date if new are added
export type TestChainNames = 'test1' | 'test2' | 'test3';

export type ChainNameOrId = ChainName | ChainId | Domain;

export type Connection = ethers.providers.Provider | ethers.Signer;
