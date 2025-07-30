import { fromZodError } from 'zod-validation-error';

import {
  type RebalancerConfigFileInput,
  RebalancerConfigSchema,
  type StrategyConfig,
} from '@hyperlane-xyz/sdk';
import { isObjEmpty } from '@hyperlane-xyz/utils';

import { readYamlOrJson } from '../../utils/files.js';

export class RebalancerConfig {
  constructor(
    public readonly warpRouteId: string,
    public readonly strategyConfig: StrategyConfig,
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

    if (isObjEmpty(strategy.chains)) {
      throw new Error('No chains configured');
    }

    return new RebalancerConfig(warpRouteId, strategy);
  }
}
