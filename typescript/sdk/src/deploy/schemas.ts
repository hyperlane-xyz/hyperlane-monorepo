import { z } from 'zod';

import { ZHash } from '../index.js';
import { ZChainName } from '../metadata/customZodTypes.js';
import { accountConfigSchema } from '../middleware/account/schemas.js';

import { ViolationType } from './types.js';

export const violationTypeSchema = z.nativeEnum(ViolationType);

const addressSchema = ZHash;

const contractSchema = z.any();

export const ownerSchema = z.union([addressSchema, accountConfigSchema]);

export const ownableConfigSchema = z.object({
  owner: ownerSchema,
});

export const checkerViolationSchema = z.object({
  chain: ZChainName,
  type: z.string(),
  expected: z.any(),
  actual: z.any(),
  contract: contractSchema.optional(),
});
