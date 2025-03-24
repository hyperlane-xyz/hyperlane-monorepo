import type { ethers } from 'ethers';
import { z } from 'zod';

import type { Domain } from '@hyperlane-xyz/utils';

import { ZHash } from './metadata/customZodTypes.js';

// An alias for string to clarify type is a chain name
export type ChainName = string;
// A map of chain names to a value type
export type ChainMap<Value> = Record<ChainName, Value>;

export type ChainNameOrId = ChainName | Domain;

export type Connection = ethers.providers.Provider | ethers.Signer;

export const OwnableSchema = z.object({
  owner: ZHash,
  ownerOverrides: z.record(ZHash).optional(),
});

export type OwnableConfig = z.infer<typeof OwnableSchema>;

export const DeployedOwnableSchema = OwnableSchema.extend({
  address: ZHash.optional(),
});
export type DeployedOwnableConfig = z.infer<typeof DeployedOwnableSchema>;

export const DerivedOwnableSchema = DeployedOwnableSchema.omit({
  ownerOverrides: true,
}).required();
export type DerivedOwnableConfig = z.infer<typeof DerivedOwnableSchema>;

export const PausableSchema = OwnableSchema.extend({
  paused: z.boolean(),
});
export type PausableConfig = z.infer<typeof PausableSchema>;
