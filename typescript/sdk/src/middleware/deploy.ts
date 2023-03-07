import { ethers } from 'ethers';

import { ProxyAdmin__factory } from '@hyperlane-xyz/core';
import {
  InterchainAccountRouter,
  InterchainAccountRouter__factory,
  InterchainQueryRouter,
  InterchainQueryRouter__factory,
} from '@hyperlane-xyz/core';

import { MultiProvider } from '../providers';
import {
  HyperlaneRouterDeployer,
  ProxiedRouterContracts,
  RouterConfig,
  RouterFactories,
} from '../router';
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
    _: MiddlewareRouterConfig,
  ): Parameters<MiddlewareFactories['router']['deploy']> {
    return [] as any;
  }

  initializeArgs(config: MiddlewareRouterConfig): any {
    return [
      config.mailbox,
      config.interchainGasPaymaster,
      config.interchainSecurityModule ?? ethers.constants.AddressZero,
      config.owner,
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
    const proxiedRouter = await this.deployProxiedContract(
      chain,
      'router',
      this.constructorArgs(config),
      proxyAdmin,
      this.initializeArgs(config),
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
    } as any;
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
    create2salt = 'accountsrouter',
  ) {
    super(multiProvider, configMap, interchainAccountFactories, create2salt);
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
