import { fromZodError } from 'zod-validation-error';

import {
  type RebalancerConfigFileInput,
  RebalancerConfigSchema,
  RebalancerStrategyOptions,
  type StrategyConfig,
} from '@hyperlane-xyz/sdk';
import { isObjEmpty } from '@hyperlane-xyz/utils';
import { readYamlOrJson } from '@hyperlane-xyz/utils/fs';

export class RebalancerConfig {
  constructor(
    public readonly warpRouteId: string,
    public readonly strategyConfig: StrategyConfig,
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

    const { warpRouteId, strategy, explorerUrl } = validationResult.data;

    // For composite strategies, check each sub-strategy
    if (strategy.rebalanceStrategy === RebalancerStrategyOptions.Composite) {
      for (const subStrategy of strategy.strategies) {
        if (isObjEmpty(subStrategy.chains)) {
          throw new Error('No chains configured in sub-strategy');
        }
      }
    } else if (isObjEmpty(strategy.chains)) {
      throw new Error('No chains configured');
    }

    return new RebalancerConfig(warpRouteId, strategy, explorerUrl);
  }
}
