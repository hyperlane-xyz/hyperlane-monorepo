import {
  ProxyAdmin__factory,
  TransparentUpgradeableProxy__factory,
} from '@hyperlane-xyz/core';

import { MultiProvider } from '../../providers/MultiProvider';
import { ProxiedContract, ProxyKind } from '../../proxy';
import { RouterConfig } from '../../router/types';
import { ChainMap, ChainName } from '../../types';
import { MiddlewareRouterDeployer } from '../MiddlewareRouterDeployer';

import {
  InterchainAccountContracts,
  InterchainAccountFactories,
  interchainAccountFactories,
} from './contracts';

type InterchainAccountConfig = RouterConfig;

export class InterchainAccountDeployer extends MiddlewareRouterDeployer<
  InterchainAccountConfig,
  InterchainAccountContracts,
  InterchainAccountFactories
> {
  constructor(
    multiProvider: MultiProvider,
    configMap: ChainMap<InterchainAccountConfig>,
    create2salt = 'accountsrouter',
  ) {
    super(multiProvider, configMap, interchainAccountFactories, create2salt);
  }

  // The OwnableMulticall implementation has an immutable owner address that
  // must be set to the InterchainAccountRouter proxy address. To achieve this, we
  // 1. deploy the proxy first with a dummy implementation
  // 2. deploy the real InterchainAccountRouter and OwnableMulticall implementation with proxy address
  // 3. upgrade the proxy to the real implementation and initialize
  async deployContracts(
    chain: ChainName,
    config: InterchainAccountConfig,
  ): Promise<InterchainAccountContracts> {
    const proxyAdmin = await this.deployContractFromFactory(
      chain,
      new ProxyAdmin__factory(),
      'proxyAdmin',
      [],
      { create2Salt: this.create2salt },
    );

    // 1. deploy the proxy first with a dummy implementation (ProxyAdmin)
    const proxy = await this.deployContractFromFactory(
      chain,
      new TransparentUpgradeableProxy__factory(),
      'proxy',
      [proxyAdmin.address, proxyAdmin.address, '0x'],
      { create2Salt: this.create2salt },
    );

    // 2. deploy the real InterchainAccountRouter and OwnableMulticall implementation with proxy address
    const domainId = this.multiProvider.getDomainId(chain);
    const implementation = await this.deployContract(
      chain,
      'router',
      [domainId, proxy.address],
      { create2Salt: this.create2salt },
    );

    // 3. upgrade the proxy to the real implementation and initialize
    await super.runIfOwner(chain, proxyAdmin, async () => {
      const initData = this.factories.router.interface.encodeFunctionData(
        'initialize',
        await this.initializeArgs(chain, config),
      );
      return this.multiProvider.handleTx(
        chain,
        proxyAdmin.upgradeAndCall(
          proxy.address,
          implementation.address,
          initData,
        ),
      );
    }); // if not owner of ProxyAdmin, checker should upgrade and initialize

    const proxiedRouter = new ProxiedContract(
      implementation.attach(proxy.address),
      {
        kind: ProxyKind.Transparent,
        implementation: implementation.address,
        proxy: proxy.address,
      },
    );

    return {
      proxyAdmin,
      proxiedRouter,
      router: proxiedRouter.contract, // for backwards compatibility
    };
  }
}
