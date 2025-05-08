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

const BaseConfigSchema = z.object({
  warpRouteId: z.string().optional(),
  checkFrequency: z.number().optional(),
  withMetrics: z.boolean().optional(),
  monitorOnly: z.boolean().optional(),
});

const ConfigSchema = BaseConfigSchema.catchall(ChainConfigSchema);

type ChainConfig = z.infer<typeof ChainConfigSchema>;

type BaseConfig = z.infer<typeof BaseConfigSchema>;

export class Config {
  static load(
    configFilePath: string,
    rebalancerKey: string,
    overrides: BaseConfig,
  ) {
    const config = readYamlOrJson(configFilePath);
    const validationResult = ConfigSchema.safeParse(config);

    if (!validationResult.success) {
      throw new Error(fromZodError(validationResult.error).message);
    }

    const {
      warpRouteId: fileWarpRouteId,
      checkFrequency: fileCheckFrequency,
      monitorOnly: fileMonitorOnly,
      withMetrics: fileWithMetrics,
      ...chains
    } = validationResult.data;

    if (!Object.keys(chains).length) {
      throw new Error('No chains configured');
    }

    const warpRouteId = overrides.warpRouteId ?? fileWarpRouteId;
    const checkFrequency = overrides.checkFrequency ?? fileCheckFrequency;
    const monitorOnly = overrides.monitorOnly ?? fileMonitorOnly ?? false;
    const withMetrics = overrides.withMetrics ?? fileWithMetrics ?? false;

    if (!warpRouteId) {
      throw new Error('warpRouteId is required');
    }

    if (!checkFrequency) {
      throw new Error('checkFrequency is required');
    }

    return new Config(
      rebalancerKey,
      warpRouteId,
      checkFrequency,
      monitorOnly,
      withMetrics,
      chains,
    );
  }

  constructor(
    public readonly rebalancerKey: string,
    public readonly warpRouteId: string,
    public readonly checkFrequency: number,
    public readonly monitorOnly: boolean,
    public readonly withMetrics: boolean,
    public readonly chains: ChainMap<ChainConfig>,
  ) {}
}
