import { z } from 'zod';

export const PopulatedTransactionSchema = z.object({
  to: z.string(),
  data: z.string(),
  chainId: z.number(),
});
