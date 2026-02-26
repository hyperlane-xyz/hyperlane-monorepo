import type { z } from 'zod';
import { fromZodError } from 'zod-validation-error';

import { readYamlOrJson } from '@hyperlane-xyz/utils/fs';

import {
  type ExternalBridgesConfigSchema,
  type RebalancerConfigFileInput,
  RebalancerConfigSchema,
  type StrategyConfig,
  getStrategyChainNames,
} from './types.js';
import { ProtocolType } from '@hyperlane-xyz/utils';

type ExternalBridgesConfig = z.infer<typeof ExternalBridgesConfigSchema>;

export class RebalancerConfig {
  constructor(
    public readonly warpRouteId: string,
    public readonly strategyConfig: StrategyConfig[],
    public readonly intentTTL: number,
    public readonly inventorySigners?: Partial<Record<ProtocolType, string>>,
    public readonly externalBridges?: ExternalBridgesConfig,
  ) {}

  /**
   * Loads config from a file
   * @param configFilePath Path to the config file
   */
  static load(configFilePath: string) {
    const config: RebalancerConfigFileInput = readYamlOrJson(configFilePath);

    const validationResult = RebalancerConfigSchema.safeParse(config);

    if (!validationResult.success) {
      throw new Error(fromZodError(validationResult.error).message);
    }

    const {
      warpRouteId,
      strategy,
      intentTTL,
      inventorySigners,
      externalBridges,
    } = validationResult.data;

    const chainNames = getStrategyChainNames(strategy);
    if (chainNames.length === 0) {
      throw new Error('No chains configured');
    }

    return new RebalancerConfig(
      warpRouteId,
      strategy,
      intentTTL,
      inventorySigners,
      externalBridges,
    );
  }
}
