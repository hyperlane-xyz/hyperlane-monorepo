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
    public readonly oft?: any,
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

    // Also load oft config if present (not validated by schema)
    const oft = (config as any).oft;

    return new RebalancerConfig(warpRouteId, strategy, oft);
  }
}
