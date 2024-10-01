import { z } from 'zod';

import { ZHash } from '../../metadata/customZodTypes.js';

export const BigNumberSchema = z.string();

export const PopulatedTransactionSchema = z.object({
  to: ZHash,
  data: z.string(),
  domainId: z.number(),
});

export const PopulatedTransactionsSchema =
  PopulatedTransactionSchema.array().refine((txs) => txs.length > 0, {
    message: 'Populated Transactions cannot be empty',
  });

export const CallDataSchema = z.object({
  to: ZHash,
  data: z.string(),
  value: BigNumberSchema.optional(),
});
