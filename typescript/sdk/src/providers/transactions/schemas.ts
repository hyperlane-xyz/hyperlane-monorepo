import { z } from 'zod';

import { ZHash } from '../../metadata/customZodTypes.js';

export const BigNumberSchema = z.string();

export const PopulatedTransactionSchema = z.object({
  to: ZHash,
  data: z.string(),
  chainId: z.number(),
});

export const PopulatedTransactionsSchema = PopulatedTransactionSchema.array();

export const CallDataSchema = z.object({
  to: ZHash,
  data: z.string(),
  value: BigNumberSchema.optional(),
});
