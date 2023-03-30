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
  ProxiedRouterFactories,
  RouterConfig,
} from '../router/types';
import { ChainMap, ChainName } from '../types';

export type InterchainAccountFactories =
  ProxiedRouterFactories<InterchainAccountRouter>;

export const interchainAccountFactories: InterchainAccountFactories = {
  router: new InterchainAccountRouter__factory(),
  proxyAdmin: new ProxyAdmin__factory(),
};

export type InterchainAccountContracts =
  ProxiedRouterContracts<InterchainAccountRouter>;

export type InterchainQueryFactories =
  ProxiedRouterFactories<InterchainQueryRouter>;

export const interchainQueryFactories: InterchainQueryFactories = {
  router: new InterchainQueryRouter__factory(),
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
      [] as any, // generic type inference fails here
      initArgs as any, // generic type inference fails here
      proxyAdmin.address,
      {
        create2Salt: this.create2salt,
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

    // manually recover from cache because cannot use HyperlaneDeployer.deployProxiedContract
    const cached = this.deployedContracts[chain]?.proxiedRouter;
    if (cached && cached.addresses.proxy && cached.addresses.implementation) {
      this.logger('Recovered full InterchainAccountRouter');
      return {
        proxyAdmin,
        proxiedRouter: cached,
        router: cached.contract,
      };
    }

    const deployer = await this.multiProvider.getSignerAddress(chain);

    // 1. deploy the proxy first with a dummy implementation (proxy admin contract)
    const proxy = await this.deployContractFromFactory(
      chain,
      new TransparentUpgradeableProxy__factory(),
      'TransparentUpgradeableProxy',
      [proxyAdmin.address, deployer, '0x'],
      { create2Salt: this.create2salt },
    );

    // 2. deploy the real InterchainAccountRouter and OwnableMulticall implementation with proxy address
    const domainId = this.multiProvider.getDomainId(chain);
    const implementation = await this.deployContract(chain, 'router', [
      domainId,
      proxy.address,
    ]);

    // 3. upgrade the proxy to the real implementation and initialize
    // adapted from HyperlaneDeployer.deployProxy.useCreate2
    const initArgs = await this.initializeArgs(chain, config);
    const initData = this.factories.router.interface.encodeFunctionData(
      'initialize',
      initArgs,
    );
    await super.upgradeAndInitialize(
      chain,
      proxy,
      implementation.address,
      initData,
    );
    await super.changeAdmin(chain, proxy, proxyAdmin.address);

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
      router: proxiedRouter.contract,
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
    create2salt = 'queryrouter2',
  ) {
    super(multiProvider, configMap, interchainQueryFactories, create2salt);
  }
}
