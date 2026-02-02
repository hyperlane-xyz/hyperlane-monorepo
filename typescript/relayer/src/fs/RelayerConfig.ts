import fs from 'fs';
import { parse as yamlParse } from 'yaml';

import { RelayerConfigInput, RelayerConfigSchema } from '../config/schema.js';

export function loadConfig(filePath: string): RelayerConfigInput {
  const content = fs.readFileSync(filePath, 'utf-8');
  const parsed = yamlParse(content);
  return RelayerConfigSchema.parse(parsed);
}
