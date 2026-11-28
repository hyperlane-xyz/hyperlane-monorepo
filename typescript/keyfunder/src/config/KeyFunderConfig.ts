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
   * Returns the union of configured destination chains and any bridge
   * originChain values so signers and RPC overrides cover bridge origins too.
   */
  getRequiredSignerChains(): string[] {
    const chains = new Set<string>(Object.keys(this.config.chains));
    for (const chainConfig of Object.values(this.config.chains)) {
      if (chainConfig.bridge?.originChain) {
        chains.add(chainConfig.bridge.originChain);
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
