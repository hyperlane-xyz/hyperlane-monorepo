import { z } from 'zod';

export const CheckpointStorageConfigSchema = z.object({
  chain: z.string(),
});
