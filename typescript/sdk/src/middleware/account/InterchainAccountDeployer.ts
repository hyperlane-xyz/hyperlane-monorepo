import {
  InterchainAccountRouter__factory,
  TransparentUpgradeableProxy__factory,
} from '@hyperlane-xyz/core';

import { HyperlaneContracts } from '../../contracts';
import { MultiProvider } from '../../providers/MultiProvider';
import { RouterConfig } from '../../router/types';
import { ChainMap, ChainName } from '../../types';
import { MiddlewareRouterDeployer } from '../MiddlewareRouterDeployer';

import {
  InterchainAccountFactories,
  interchainAccountFactories,
} from './contracts';

export type InterchainAccountConfig = RouterConfig;

export class InterchainAccountDeployer extends MiddlewareRouterDeployer<
  InterchainAccountConfig,
  InterchainAccountFactories,
  InterchainAccountRouter__factory
> {
  readonly routerContractName = 'interchainAccountRouter';

  constructor(
    multiProvider: MultiProvider,
    configMap: ChainMap<InterchainAccountConfig>,
  ) {
    super(multiProvider, configMap, interchainAccountFactories);
  }

  // The OwnableMulticall implementation has an immutable owner address that
  // must be set to the InterchainAccountRouter proxy address. To achieve this, we
  // 1. deploy the proxy first with a dummy implementation
  // 2. deploy the real InterchainAccountRouter and OwnableMulticall implementation with proxy address
  // 3. upgrade the proxy to the real implementation and initialize
  async deployContracts(
    chain: ChainName,
    config: InterchainAccountConfig,
  ): Promise<HyperlaneContracts<InterchainAccountFactories>> {
    const proxyAdmin = await this.deployContract(chain, 'proxyAdmin', []);

    // adapted from HyperlaneDeployer.deployProxiedContract
    const cached = this.deployedContracts[chain]?.interchainAccountRouter;
    if (cached) {
      this.logger('Recovered InterchainAccountRouter');
      return {
        proxyAdmin,
        interchainAccountRouter: cached,
      };
    }

    const deployer = await this.multiProvider.getSignerAddress(chain);

    // 1. deploy the proxy first with a dummy implementation (proxy admin contract)
    const proxy = await this.deployContractFromFactory(
      chain,
      new TransparentUpgradeableProxy__factory(),
      'TransparentUpgradeableProxy',
      [proxyAdmin.address, deployer, '0x'],
    );

    // 2. deploy the real InterchainAccountRouter and OwnableMulticall implementation with proxy address
    const domainId = this.multiProvider.getDomainId(chain);
    const implementation = await this.deployContract(
      chain,
      'interchainAccountRouter',
      [domainId, proxy.address],
    );

    // 3. upgrade the proxy to the real implementation and initialize
    // adapted from HyperlaneDeployer.deployProxy.useCreate2
    const initArgs = await this.initializeArgs(chain, config);
    await super.upgradeAndInitialize(chain, proxy, implementation, initArgs);
    await super.changeAdmin(chain, proxy, proxyAdmin.address);

    const proxiedRouter = implementation.attach(proxy.address);

    return {
      proxyAdmin,
      interchainAccountRouter: proxiedRouter,
    };
  }
}
