import fs from 'fs';
import { parse as yamlParse } from 'yaml';

import { RelayerConfigInput, RelayerConfigSchema } from '../config/schema.js';

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
