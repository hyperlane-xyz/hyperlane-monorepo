import { z } from 'zod';

import { ZChainName, ZHash, ZNzUint } from '../metadata/customZodTypes.js';

export const TimelockConfigSchema = z.object({
  minimumDelay: ZNzUint,
  proposers: z.array(ZHash).min(1),
  executors: z.array(ZHash).min(1),
  admin: ZHash.optional(),
});

export const TimelockConfigMapSchema = z.record(
  ZChainName,
  TimelockConfigSchema,
);

export type TimelockConfig = z.infer<typeof TimelockConfigSchema>;
export type TimelockConfigMap = z.infer<typeof TimelockConfigMapSchema>;
