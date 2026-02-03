import { fromZodError } from 'zod-validation-error';

import { assert } from '@hyperlane-xyz/utils';
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
    public readonly strategyConfig: StrategyConfig[],
  ) {}

  /**
   * Loads config from a file
   * @param configFilePath Path to the config file
   */
  static load(configFilePath: string) {
    const config = readYamlOrJson<RebalancerConfigFileInput>(configFilePath);
    assert(config, `Empty rebalancer config file at ${configFilePath}`);

    const validationResult = RebalancerConfigSchema.safeParse(config);

    if (!validationResult.success) {
      throw new Error(fromZodError(validationResult.error).message);
    }

    const { warpRouteId, strategy } = validationResult.data;

    // Check that at least one chain is configured across all strategies
    const chainNames = getStrategyChainNames(strategy);
    if (chainNames.length === 0) {
      throw new Error('No chains configured');
    }

    return new RebalancerConfig(warpRouteId, strategy);
  }
}
