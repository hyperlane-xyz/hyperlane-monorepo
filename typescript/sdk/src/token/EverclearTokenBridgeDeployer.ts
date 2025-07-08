import { EverclearTokenBridge__factory } from '@hyperlane-xyz/core';
import { objMap, promiseObjAll } from '@hyperlane-xyz/utils';

import { HyperlaneContracts } from '../contracts/types.js';
import {
  DeployerOptions,
  HyperlaneDeployer,
} from '../deploy/HyperlaneDeployer.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { ChainMap, ChainName } from '../types.js';

import { EverclearTokenConfig } from './types.js';

export type EverclearTokenBridgeContracts = {
  everclear: EverclearTokenBridge__factory;
};

export class EverclearTokenBridgeDeployer extends HyperlaneDeployer<
  EverclearTokenConfig,
  EverclearTokenBridgeContracts
> {
  constructor(multiProvider: MultiProvider, options: DeployerOptions = {}) {
    super(
      multiProvider,
      { everclear: new EverclearTokenBridge__factory() },
      options,
    );
  }

  async deployContracts(
    chain: ChainName,
    config: EverclearTokenConfig,
  ): Promise<HyperlaneContracts<EverclearTokenBridgeContracts>> {
    // EverclearTokenBridge constructor takes (IERC20 _erc20, IEverclearAdapter _everclearAdapter)
    const everclear = await this.deployContract(chain, 'everclear', [
      config.token, // The ERC20 token address
      config.everclearAdapter, // The Everclear adapter address
    ]);

    return {
      everclear,
    };
  }

  async deploy(
    configMap: ChainMap<EverclearTokenConfig>,
  ): Promise<ChainMap<HyperlaneContracts<EverclearTokenBridgeContracts>>> {
    const result = await promiseObjAll(
      objMap(configMap, async (chain, config) => {
        this.logger.info(`Deploying to ${chain}`);
        return this.deployContracts(chain, config);
      }),
    );

    return result;
  }
}
