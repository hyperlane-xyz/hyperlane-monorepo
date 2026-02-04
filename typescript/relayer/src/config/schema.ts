import { z } from 'zod';

export const RelayerConfigSchema = z.object({
  chains: z.array(z.string()).optional(),
  whitelist: z.record(z.array(z.string())).optional(),
  warpRouteId: z.string().optional(),
  retryTimeout: z.number().positive().optional(),
  cacheFile: z.string().optional(),
});

export type RelayerConfigInput = z.infer<typeof RelayerConfigSchema>;
