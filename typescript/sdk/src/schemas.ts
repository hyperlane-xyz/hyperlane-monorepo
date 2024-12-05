import { z } from 'zod';

import { ZHash } from './metadata/customZodTypes.js';

export const OwnableSchema = z.object({
  owner: ZHash,
  ownerOverrides: z.record(ZHash).optional(),
});

export const DeployedOwnableSchema = OwnableSchema.extend({
  address: ZHash.optional(),
});

export const DerivedOwnableSchema = DeployedOwnableSchema.omit({
  ownerOverrides: true,
}).required();

export const PausableSchema = OwnableSchema.extend({
  paused: z.boolean(),
});
