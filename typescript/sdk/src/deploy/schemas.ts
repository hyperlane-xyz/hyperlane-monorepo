import { z } from 'zod';

import { AccountConfigSchema } from '../middleware/account/schemas.js';

export const OwnerSchema = z.union([z.string(), AccountConfigSchema]);

export const OwnableConfigSchema = z.object({
  owner: OwnerSchema,
});

export const PausableSchema = OwnableConfigSchema.extend({
  paused: z.boolean(),
});
