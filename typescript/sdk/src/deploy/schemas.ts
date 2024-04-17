import { z } from 'zod';

import { accountConfigSchema } from '../middleware/account/schemas.js';

export const ownerSchema = z.union([z.string(), accountConfigSchema]);

export const ownableConfigSchema = z.object({
  owner: ownerSchema,
});
