import fs from 'fs';
import * as YAML from 'yaml';
import { z } from 'zod';

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

    return KeyFunderConfigLoader.fromObject(rawConfig);
  }

  static fromObject(config: KeyFunderConfigInput): KeyFunderConfigLoader {
    const validationResult = KeyFunderConfigSchema.safeParse(config);
    if (!validationResult.success) {
      throw new Error(
        `Invalid keyfunder config: ${z.prettifyError(validationResult.error)}`,
      );
    }
    return new KeyFunderConfigLoader(validationResult.data);
  }

  getConfiguredChains(): string[] {
    return Object.keys(this.config.chains);
  }

  /**
   * Returns active destination chains plus any bridge originChain referenced
   * by an active destination, ignoring retired origins on skipped destinations.
   */
  getRequiredSignerChains(): string[] {
    const activeDestinations = this.getChainsToProcess();
    const chains = new Set<string>(activeDestinations);
    for (const chain of activeDestinations) {
      const originChain = this.config.chains[chain]?.bridge?.originChain;
      if (originChain) {
        chains.add(originChain);
      }
    }
    return Array.from(chains);
  }

  getChainsToProcess(): string[] {
    const allChains = this.getConfiguredChains();
    const chainsToSkip = new Set(this.config.chainsToSkip ?? []);
    return allChains.filter((chain) => !chainsToSkip.has(chain));
  }
}
