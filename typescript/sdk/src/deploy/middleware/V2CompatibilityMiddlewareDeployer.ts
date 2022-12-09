import { V2CompatibilityRouter__factory } from '@hyperlane-xyz/core';

import { HyperlaneCore } from '../../core/HyperlaneCore';
import {
  V2CompatibilityContracts,
  V2CompatibilityFactories,
  v2CompatibilityFactories,
} from '../../middleware';
import { MultiProvider } from '../../providers/MultiProvider';
import { ChainMap, ChainName } from '../../types';
import { HyperlaneRouterDeployer } from '../router/HyperlaneRouterDeployer';
import { RouterConfig } from '../router/types';

export type V2CompatibilityConfig = RouterConfig & {
  v1Domains: number[];
  v2Domains: number[];
};

export class V2CompatibilityRouterDeployer<
  Chain extends ChainName,
> extends HyperlaneRouterDeployer<
  Chain,
  V2CompatibilityConfig,
  V2CompatibilityContracts,
  V2CompatibilityFactories
> {
  constructor(
    multiProvider: MultiProvider<Chain>,
    configMap: ChainMap<Chain, V2CompatibilityConfig>,
    protected core: HyperlaneCore<Chain>,
    protected create2salt = 'asdasdsd',
  ) {
    super(multiProvider, configMap, v2CompatibilityFactories, {});
  }

  // Custom contract deployment logic can go here
  // If no custom logic is needed, call deployContract for the router
  async deployContracts(
    chain: Chain,
    config: V2CompatibilityConfig,
  ): Promise<V2CompatibilityContracts> {
    const initCalldata =
      V2CompatibilityRouter__factory.createInterface().encodeFunctionData(
        'initialize',
        [config.owner, config.connectionManager, config.interchainGasPaymaster],
      );
    const router = await this.deployContract(chain, 'router', [], {
      create2Salt: this.create2salt + 'router',
      initCalldata,
    });

    this.logger(`Set domain mapping`, config.v1Domains, config.v2Domains);
    await this.multiProvider
      .getChainConnection(chain)
      .handleTx(router.mapDomains(config.v1Domains, config.v2Domains));

    return {
      router,
    };
  }
}
