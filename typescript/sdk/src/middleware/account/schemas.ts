import { z } from 'zod';

import { ZHash } from '../../index.js';
import { ZChainName } from '../../metadata/customZodTypes.js';

const addressSchema = ZHash;

export const accountConfigSchema = z.object({
  origin: ZChainName,
  owner: addressSchema,
  localRouter: addressSchema.optional(),
  routerOverride: addressSchema.optional(),
  ismOverride: addressSchema.optional(),
});
