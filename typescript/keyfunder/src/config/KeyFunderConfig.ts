import fs from 'fs';
import YAML from 'yaml';
import { fromZodError } from 'zod-validation-error';

import {
  KeyFunderConfig,
  KeyFunderConfigInput,
  KeyFunderConfigSchema,
} from './types.js';

export class KeyFunderConfigLoader {
  private constructor(public readonly config: KeyFunderConfig) {}

  static load(filePath: string): KeyFunderConfigLoader {
    if (!fs.existsSync(filePath)) {
      throw new Error(`Config file not found: ${filePath}`);
    }

    const content = fs.readFileSync(filePath, 'utf8');
    const rawConfig: KeyFunderConfigInput = YAML.parse(content);

    const validationResult = KeyFunderConfigSchema.safeParse(rawConfig);
    if (!validationResult.success) {
      throw new Error(
        `Invalid keyfunder config: ${fromZodError(validationResult.error).message}`,
      );
    }

    return new KeyFunderConfigLoader(validationResult.data);
  }

  static fromObject(config: KeyFunderConfigInput): KeyFunderConfigLoader {
    const validationResult = KeyFunderConfigSchema.safeParse(config);
    if (!validationResult.success) {
      throw new Error(
        `Invalid keyfunder config: ${fromZodError(validationResult.error).message}`,
      );
    }
    return new KeyFunderConfigLoader(validationResult.data);
  }

  getConfiguredChains(): string[] {
    return Object.keys(this.config.chains);
  }

  getChainsToProcess(): string[] {
    const allChains = this.getConfiguredChains();
    const chainsToSkip = new Set(this.config.chainsToSkip ?? []);
    return allChains.filter((chain) => !chainsToSkip.has(chain));
  }

  getFunderPrivateKeyEnvVar(): string {
    return this.config.funder?.privateKeyEnvVar ?? 'FUNDER_PRIVATE_KEY';
  }
}
