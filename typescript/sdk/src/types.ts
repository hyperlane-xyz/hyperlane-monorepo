import type { ethers } from 'ethers';

import type { Domain } from '@hyperlane-xyz/utils';

// An alias for string to clarify type is a chain name
export type ChainName = string;
// A map of chain names to a value type
export type ChainMap<Value> = Record<ChainName, Value>;

export type ChainNameOrId = ChainName | Domain;

export type Connection = ethers.providers.Provider | ethers.Signer;
