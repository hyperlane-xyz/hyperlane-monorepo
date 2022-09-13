import {
  AbacusCore,
  AbacusRouterDeployer,
  ChainMap,
  ChainName,
  MultiProvider,
  RouterConfig,
} from '@abacus-network/sdk';

import {
  InterchainAccountContracts,
  InterchainAccountFactories,
} from './contracts';

export type InterchainAccountConfig = RouterConfig;

export class InterchainAccountDeployer<
  Chain extends ChainName,
> extends AbacusRouterDeployer<
  Chain,
  InterchainAccountConfig,
  InterchainAccountContracts,
  InterchainAccountFactories
> {
  constructor(
    multiProvider: MultiProvider<Chain>,
    configMap: ChainMap<Chain, InterchainAccountConfig>,
    protected core: AbacusCore<Chain>,
  ) {
    super(multiProvider, configMap, InterchainAccountFactories, {});
  }

  // Custom contract deployment logic can go here
  // If no custom logic is needed, call deployContract for the router
  async deployContracts(chain: Chain, config: InterchainAccountConfig) {
    const router = await this.deployContract(chain, 'router', [
      config.abacusConnectionManager,
      config.interchainGasPaymaster,
    ]);
    return {
      router,
    };
  }
}
