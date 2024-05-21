import { z } from 'zod';

import { ZHash } from '../../metadata/customZodTypes.js';

export const PopulatedTransactionSchema = z.object({
  to: z.string(),
  data: z.string(),
  chainId: z.number(),
});

export const BigNumberSchema = z.any();

export const CallDataSchema = z.object({
  to: ZHash,
  data: z.string(),
  value: BigNumberSchema.optional(),
});
