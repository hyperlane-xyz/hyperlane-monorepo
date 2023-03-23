import { ethers } from 'ethers';

import {
  InterchainAccountRouter,
  InterchainAccountRouter__factory,
  InterchainQueryRouter,
  InterchainQueryRouter__factory,
  ProxyAdmin__factory,
  TransparentUpgradeableProxy__factory,
} from '@hyperlane-xyz/core';

import { MultiProvider } from '../providers/MultiProvider';
import { ProxiedContract, ProxyKind } from '../proxy';
import { HyperlaneRouterDeployer } from '../router/HyperlaneRouterDeployer';
import {
  ProxiedRouterContracts,
  RouterConfig,
  RouterFactories,
} from '../router/types';
import { ChainMap, ChainName } from '../types';

export type InterchainAccountFactories =
  RouterFactories<InterchainAccountRouter>;

export const interchainAccountFactories: InterchainAccountFactories = {
  router: new InterchainAccountRouter__factory(),
};

export type InterchainAccountContracts =
  ProxiedRouterContracts<InterchainAccountRouter>;

export type InterchainQueryFactories = RouterFactories<InterchainQueryRouter>;

export const interchainQueryFactories: InterchainQueryFactories = {
  router: new InterchainQueryRouter__factory(),
};

export type InterchainQueryContracts =
  ProxiedRouterContracts<InterchainQueryRouter>;

export abstract class MiddlewareRouterDeployer<
  MiddlewareRouterConfig extends RouterConfig,
  MiddlewareRouterContracts extends ProxiedRouterContracts,
  MiddlewareFactories extends RouterFactories,
> extends HyperlaneRouterDeployer<
  MiddlewareRouterConfig,
  MiddlewareRouterContracts,
  MiddlewareFactories
> {
  constructor(
    multiProvider: MultiProvider,
    configMap: ChainMap<MiddlewareRouterConfig>,
    factories: MiddlewareFactories,
    protected create2salt = 'middlewarerouter',
  ) {
    super(multiProvider, configMap, factories);
  }

  constructorArgs(
    _chain: ChainName,
    _config: MiddlewareRouterConfig,
  ): Parameters<MiddlewareFactories['router']['deploy']> {
    return [] as any;
  }

  async initializeArgs(
    chain: ChainName,
    config: MiddlewareRouterConfig,
  ): Promise<[string, string, string, string]> {
    // configure owner as signer for additional initialization steps
    // ownership is transferred to config.owner in HyperlaneRouterDeployer.deploy
    const owner = await this.multiProvider.getSignerAddress(chain);
    return [
      config.mailbox,
      config.interchainGasPaymaster,
      config.interchainSecurityModule ?? ethers.constants.AddressZero,
      owner,
    ];
  }

  async deployContracts(
    chain: ChainName,
    config: MiddlewareRouterConfig,
  ): Promise<MiddlewareRouterContracts> {
    const proxyAdmin = await this.deployContractFromFactory(
      chain,
      new ProxyAdmin__factory(),
      'proxyAdmin',
      [],
      { create2Salt: this.create2salt },
    );
    const initArgs = await this.initializeArgs(chain, config);
    const proxiedRouter = await this.deployProxiedContract(
      chain,
      'router',
      this.constructorArgs(chain, config),
      proxyAdmin,
      initArgs as any, // generic type inference fails here
      {
        create2Salt: this.create2salt,
      },
    );
    await this.multiProvider.handleTx(
      chain,
      proxyAdmin.transferOwnership(config.owner),
    );
    return {
      proxyAdmin,
      proxiedRouter,
      router: proxiedRouter.contract, // for backwards compatibility
    } as any; // generic type inference fails here
  }
}

type InterchainAccountConfig = RouterConfig;

export class InterchainAccountDeployer extends MiddlewareRouterDeployer<
  InterchainAccountConfig,
  InterchainAccountContracts,
  InterchainAccountFactories
> {
  constructor(
    multiProvider: MultiProvider,
    configMap: ChainMap<InterchainAccountConfig>,
    create2Salt = 'accountsrouter',
  ) {
    super(multiProvider, configMap, interchainAccountFactories, create2Salt);
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

type InterchainQueryConfig = RouterConfig;

export class InterchainQueryDeployer extends MiddlewareRouterDeployer<
  InterchainQueryConfig,
  InterchainQueryContracts,
  InterchainQueryFactories
> {
  constructor(
    multiProvider: MultiProvider,
    configMap: ChainMap<InterchainQueryConfig>,
    create2salt = 'queryrouter',
  ) {
    super(multiProvider, configMap, interchainQueryFactories, create2salt);
  }
}
