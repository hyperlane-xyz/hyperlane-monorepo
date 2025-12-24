import fs from 'fs';
import { parse as yamlParse } from 'yaml';
import { z } from 'zod';

export const RelayerConfigSchema = z.object({
  chains: z.array(z.string()).optional(),
  whitelist: z.record(z.array(z.string())).optional(),
  warpRouteId: z.string().optional(),
  retryTimeout: z.number().positive().optional(),
  cacheFile: z.string().optional(),
});

export type RelayerConfigInput = z.infer<typeof RelayerConfigSchema>;

export class RelayerConfig {
  constructor(public readonly config: RelayerConfigInput) {}

  static load(filePath: string): RelayerConfig {
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = yamlParse(content);
    const validated = RelayerConfigSchema.parse(parsed);
    return new RelayerConfig(validated);
  }

  get chains(): string[] | undefined {
    return this.config.chains;
  }

  get whitelist(): Record<string, string[]> | undefined {
    return this.config.whitelist;
  }

  get warpRouteId(): string | undefined {
    return this.config.warpRouteId;
  }

  get retryTimeout(): number | undefined {
    return this.config.retryTimeout;
  }

  get cacheFile(): string | undefined {
    return this.config.cacheFile;
  }
}
