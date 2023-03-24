import { ethers } from 'ethers';

import {
  InterchainAccountRouter,
  InterchainAccountRouter__factory,
  InterchainQueryRouter,
  InterchainQueryRouter__factory,
  ProxyAdmin__factory,
} from '@hyperlane-xyz/core';

import { MultiProvider } from '../providers/MultiProvider';
import { ProxiedContract, ProxyKind } from '../proxy';
import { HyperlaneRouterDeployer } from '../router/HyperlaneRouterDeployer';
import {
  ProxiedRouterContracts,
  ProxiedRouterFactories,
  RouterConfig,
} from '../router/types';
import { ChainMap, ChainName } from '../types';

export type InterchainAccountFactories =
  ProxiedRouterFactories<InterchainAccountRouter>;

export const interchainAccountFactories: InterchainAccountFactories = {
  router: new InterchainAccountRouter__factory(),
  // TODO: where to put these?
  interchainAccountRouter: new InterchainAccountRouter__factory(),
  proxyAdmin: new ProxyAdmin__factory(),
};

export type InterchainAccountContracts =
  ProxiedRouterContracts<InterchainAccountRouter>;

export type InterchainQueryFactories =
  ProxiedRouterFactories<InterchainQueryRouter>;

export const interchainQueryFactories: InterchainQueryFactories = {
  router: new InterchainQueryRouter__factory(),
  // TODO: where to put these?
  interchainQueryRouter: new InterchainQueryRouter__factory(),
  proxyAdmin: new ProxyAdmin__factory(),
};

export type InterchainQueryContracts =
  ProxiedRouterContracts<InterchainQueryRouter>;

export abstract class MiddlewareRouterDeployer<
  MiddlewareRouterConfig extends RouterConfig,
  MiddlewareRouterContracts extends ProxiedRouterContracts,
  MiddlewareFactories extends ProxiedRouterFactories,
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
    const proxyAdmin = await this.deployContract(
      chain,
      'proxyAdmin',
      [] as any, // generic type inference fails here
    );

    const initArgs = await this.initializeArgs(chain, config);
    const proxiedRouter = await this.deployProxiedContract(
      chain,
      'router',
      this.constructorArgs(chain, config),
      initArgs as any, // generic type inference fails here
      {
        create2Salt: this.create2salt,
        proxyAdmin: proxyAdmin.address,
      },
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
    const proxyAdmin = await this.deployContract(chain, 'proxyAdmin', []);

    // 1. deploy the proxy first with a dummy implementation
    const dummyImplementation = InterchainAccountRouter__factory.connect(
      proxyAdmin.address,
      this.multiProvider.getSigner(chain),
    );
    const initArgs = await this.initializeArgs(chain, config);
    const proxy = await this.deployProxy(
      chain,
      dummyImplementation,
      initArgs,
      {
        create2Salt: this.create2salt,
      },
      false, // skip initializing dummy implementation
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
    this.logger('Upgrading proxy to real implementation and initializing');
    const initData = this.factories.router.interface.encodeFunctionData(
      'initialize',
      initArgs,
    );
    await super.upgradeAndInitialize(
      chain,
      proxy.proxy,
      implementation.address,
      initData,
    );
    await super.changeAdmin(chain, proxy.proxy, proxyAdmin.address);

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
      interchainAccountRouter: proxiedRouter, // for serialization
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
