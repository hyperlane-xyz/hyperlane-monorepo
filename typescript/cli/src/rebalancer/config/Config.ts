import { z } from 'zod';
import { fromZodError } from 'zod-validation-error';

import { ChainMap } from '@hyperlane-xyz/sdk';

import { readYamlOrJson } from '../../utils/files.js';

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

const ConfigSchema = z
  .object({
    monitorOnly: z.boolean().default(false),
  })
  .catchall(ChainConfigSchema);

type ChainConfig = z.infer<typeof ChainConfigSchema>;

export class Config {
  static fromFile(path: string) {
    const config = readYamlOrJson(path);
    const validationResult = ConfigSchema.safeParse(config);

    if (!validationResult.success) {
      throw new Error(fromZodError(validationResult.error).message);
    }

    const { monitorOnly, ...chains } = validationResult.data;

    return new Config(monitorOnly, chains);
  }

  constructor(
    public readonly monitorOnly: boolean,
    public readonly chains: ChainMap<ChainConfig>,
  ) {}
}
