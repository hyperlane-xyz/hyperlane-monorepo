import { z } from 'zod/v4';

import { ZHash } from '../../metadata/customZodTypes.js';

export const BigNumberSchema = z.string();

export const CallDataSchema = z.object({
  to: ZHash,
  data: z.string(),
  value: BigNumberSchema.optional(),
});

export type CallData = z.infer<typeof CallDataSchema>;
