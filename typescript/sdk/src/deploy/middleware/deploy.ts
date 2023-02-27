import {
  InterchainAccountRouter__factory,
  InterchainQueryRouter__factory,
} from '@hyperlane-xyz/core';

import { HyperlaneCore } from '../../core/HyperlaneCore';
import {
  InterchainAccountContracts,
  InterchainAccountFactories,
  InterchainQueryContracts,
  InterchainQueryFactories,
  interchainAccountFactories,
  interchainQueryFactories,
} from '../../middleware';
import { MultiProvider } from '../../providers/MultiProvider';
import { ChainMap, ChainName } from '../../types';
import { HyperlaneDeployer } from '../HyperlaneDeployer';
import { HyperlaneRouterDeployer } from '../router/HyperlaneRouterDeployer';
import { RouterConfig } from '../router/types';

export type InterchainAccountConfig = RouterConfig;

export class InterchainAccountDeployer extends HyperlaneDeployer<
  InterchainAccountConfig,
  InterchainAccountContracts,
  InterchainAccountFactories
> {
  constructor(
    multiProvider: MultiProvider,
    configMap: ChainMap<InterchainAccountConfig>,
    protected core: HyperlaneCore,
    protected create2salt = 'asdasdsd',
  ) {
    super(multiProvider, configMap, interchainAccountFactories, {});
  }

  // Custom contract deployment logic can go here
  // If no custom logic is needed, call deployContract for the router
  async deployContracts(
    chain: ChainName,
    config: InterchainAccountConfig,
  ): Promise<InterchainAccountContracts> {
    const initCalldata = HyperlaneRouterDeployer.getInitArgs(
      config,
      InterchainAccountRouter__factory.createInterface(),
    );
    const router = await this.deployContract(chain, 'router', [], {
      create2Salt: this.create2salt + 'router',
      initCalldata,
    });
    return {
      router,
    };
  }
}

export type InterchainQueryConfig = RouterConfig;

export class InterchainQueryDeployer extends HyperlaneRouterDeployer<
  InterchainQueryConfig,
  InterchainQueryContracts,
  InterchainQueryFactories
> {
  constructor(
    multiProvider: MultiProvider,
    configMap: ChainMap<InterchainQueryConfig>,
    protected core: HyperlaneCore,
    // TODO replace salt with 'hyperlane' before next redeploy
    protected create2salt = 'asdasdsd',
  ) {
    super(multiProvider, configMap, interchainQueryFactories, {});
  }

  // Custom contract deployment logic can go here
  // If no custom logic is needed, call deployContract for the router
  async deployContracts(
    chain: ChainName,
    config: InterchainQueryConfig,
  ): Promise<InterchainQueryContracts> {
    const initCalldata = HyperlaneRouterDeployer.getInitArgs(
      config,
      InterchainQueryRouter__factory.createInterface(),
    );
    const router = await this.deployContract(chain, 'router', [], {
      create2Salt: this.create2salt + 'router',
      initCalldata,
    });
    return {
      router,
    };
  }
}
