import type { ethers } from 'ethers';

import type { ChainId, Domain } from '@hyperlane-xyz/utils';

// An alias for string to clarify type is a chain name
export type ChainName = string;
// A map of chain names to a value type
export type ChainMap<Value> = Record<string, Value>;

export type ChainNameOrId = ChainName | ChainId | Domain;

export type Connection = ethers.providers.Provider | ethers.Signer;
