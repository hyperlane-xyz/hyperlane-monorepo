import { z } from 'zod';
import { fromZodError } from 'zod-validation-error';

import { ChainMap, ChainName } from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

import { readYamlOrJson } from '../../utils/files.js';

export type ChainConfig = {
  weight: bigint;
  tolerance: bigint;
  bridge: Address;
};

export class Config {
  [key: ChainName]: ChainConfig;

  static fromFile(path: string) {
    const ChainConfigSchema = z.object({
      weight: z
        .string()
        .or(z.number())
        .transform((val) => BigInt(val)),
      tolerance: z
        .string()
        .or(z.number())
        .transform((val) => BigInt(val)),
      bridge: z.string().regex(/0x[a-fA-F0-9]{40}/),
    });

    const ConfigSchema = z.record(z.string(), ChainConfigSchema);
    const config = readYamlOrJson(path);
    const validationResult = ConfigSchema.safeParse(config);

    if (!validationResult.success) {
      throw new Error(fromZodError(validationResult.error).message);
    }

    return new Config(validationResult.data);
  }

  constructor(data: ChainMap<ChainConfig>) {
    Object.assign(this, data);
  }
}
