import { fromZodError } from 'zod-validation-error';

import {
  type ChainMap,
  type RebalancerChainConfig,
  type RebalancerConfigFileInput,
  RebalancerConfigSchema,
  type RebalancerStrategyOptions,
} from '@hyperlane-xyz/sdk';
import { isObjEmpty } from '@hyperlane-xyz/utils';

import { readYamlOrJson } from '../../utils/files.js';

export class RebalancerConfig {
  constructor(
    public readonly warpRouteId: string,
    public readonly rebalanceStrategy: RebalancerStrategyOptions,
    public readonly chains: ChainMap<RebalancerChainConfig>,
  ) {}

  /**
   * Loads config from a file
   * @param extraArgs Params to be provided along the config file (E.g. Params provided from cli args)
   */
  static load(configFilePath: string) {
    const config: RebalancerConfigFileInput = readYamlOrJson(configFilePath);
    const validationResult = RebalancerConfigSchema.safeParse(config);

    if (!validationResult.success) {
      throw new Error(fromZodError(validationResult.error).message);
    }

    const { warpRouteId, rebalanceStrategy, ...chains } = validationResult.data;

    if (isObjEmpty(chains)) {
      throw new Error('No chains configured');
    }

    return new RebalancerConfig(warpRouteId, rebalanceStrategy, chains);
  }
}
