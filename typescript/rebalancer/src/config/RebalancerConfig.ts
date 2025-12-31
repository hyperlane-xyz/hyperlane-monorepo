import { fromZodError } from 'zod-validation-error';

import { readYamlOrJson } from '@hyperlane-xyz/utils/fs';

import {
  type RebalancerConfigFileInput,
  RebalancerConfigSchema,
  type StrategyConfig,
  getStrategyChainNames,
} from './types.js';

export class RebalancerConfig {
  constructor(
    public readonly warpRouteId: string,
    public readonly strategyConfig: StrategyConfig,
    /** Optional explorer URL for message tracking (defaults to Hyperlane Explorer) */
    public readonly explorerUrl?: string,
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

    const { warpRouteId, strategy } = validationResult.data;

    if (getStrategyChainNames(strategy).length === 0) {
      throw new Error('No chains configured');
    }

    return new RebalancerConfig(warpRouteId, strategy);
  }
}
