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

const ConfigWithoutChainsSchema = z.object({
  warpRouteId: z.string().optional(),
  checkFrequency: z.number().optional(),
  withMetrics: z.boolean().optional(),
  monitorOnly: z.boolean().optional(),
});

const ConfigSchema = ConfigWithoutChainsSchema.catchall(ChainConfigSchema);

type ChainConfig = z.infer<typeof ChainConfigSchema>;

type ConfigWithoutChains = z.infer<typeof ConfigWithoutChainsSchema>;

export class Config {
  static fromFile(configFilePath: string, overrides: ConfigWithoutChains) {
    const config = readYamlOrJson(configFilePath);
    const validationResult = ConfigSchema.safeParse(config);

    if (!validationResult.success) {
      throw new Error(fromZodError(validationResult.error).message);
    }

    const {
      warpRouteId = overrides.warpRouteId,
      checkFrequency = overrides.checkFrequency,
      monitorOnly = overrides.monitorOnly,
      withMetrics = overrides.withMetrics,
      ...chains
    } = validationResult.data;

    if (!warpRouteId) {
      throw new Error('warpRouteId is required');
    }

    if (!checkFrequency) {
      throw new Error('checkFrequency is required');
    }

    return new Config(
      warpRouteId,
      checkFrequency,
      monitorOnly ?? false,
      withMetrics ?? false,
      chains,
    );
  }

  constructor(
    public readonly warpRouteId: string,
    public readonly checkFrequency: number,
    public readonly monitorOnly: boolean,
    public readonly withMetrics: boolean,
    public readonly chains: ChainMap<ChainConfig>,
  ) {}
}
