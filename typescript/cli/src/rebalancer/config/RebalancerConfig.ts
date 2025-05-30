import { fromZodError } from 'zod-validation-error';

import {
  type ChainMap,
  type RebalancerChainConfig,
  type RebalancerConfigFileInput,
  RebalancerConfigSchema,
  type RebalancerStrategyOptions,
} from '@hyperlane-xyz/sdk';

import { ENV } from '../../utils/env.js';
import { readYamlOrJson } from '../../utils/files.js';

export class RebalancerConfig {
  constructor(
    public readonly warpRouteId: string,
    public readonly checkFrequency: number,
    public readonly monitorOnly: boolean,
    public readonly withMetrics: boolean,
    public readonly coingeckoApiKey: string | undefined,
    public readonly rebalanceStrategy: RebalancerStrategyOptions,
    public readonly chains: ChainMap<RebalancerChainConfig>,
  ) {}

  /**
   * Loads config from a file
   * @param extraArgs Params to be provided along the config file (E.g. Params provided from cli args)
   */
  static load(
    configFilePath: string,
    extraArgs: {
      checkFrequency: number;
      monitorOnly: boolean;
      withMetrics: boolean;
    },
  ) {
    const config: RebalancerConfigFileInput = readYamlOrJson(configFilePath);
    const validationResult = RebalancerConfigSchema.safeParse(config);

    if (!validationResult.success) {
      throw new Error(fromZodError(validationResult.error).message);
    }

    const { warpRouteId, rebalanceStrategy, ...chains } = validationResult.data;

    if (!Object.keys(chains).length) {
      throw new Error('No chains configured');
    }

    return new RebalancerConfig(
      warpRouteId,
      extraArgs.checkFrequency,
      extraArgs.monitorOnly,
      extraArgs.withMetrics,
      ENV.COINGECKO_API_KEY,
      rebalanceStrategy,
      chains,
    );
  }
}
