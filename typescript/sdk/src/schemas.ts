import { z } from 'zod';

import { isAddress } from '@hyperlane-xyz/utils';

export const OwnerSchema = z.string().refine((v) => isAddress(v), {
  message: 'Owner must be a valid address',
});

export const OwnableSchema = z.object({
  owner: OwnerSchema,
});

export const PausableSchema = OwnableSchema.extend({
  paused: z.boolean(),
});
