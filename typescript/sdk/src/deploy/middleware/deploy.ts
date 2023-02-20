import { ethers } from 'ethers';

import { ProxyAdmin__factory } from '@hyperlane-xyz/core';

import {
  InterchainAccountContracts,
  InterchainAccountFactories,
  InterchainQueryContracts,
  InterchainQueryFactories,
  interchainAccountFactories,
  interchainQueryFactories,
} from '../../middleware';
import { MultiProvider } from '../../providers/MultiProvider';
import { ProxiedRouterContracts, RouterFactories } from '../../router';
import { ChainMap, ChainName } from '../../types';
import { HyperlaneRouterDeployer } from '../router/HyperlaneRouterDeployer';
import { RouterConfig } from '../router/types';

export abstract class MiddlewareRouterDeployer<
  Chain extends ChainName,
  MiddlewareRouterConfig extends RouterConfig,
  MiddlewareRouterContracts extends ProxiedRouterContracts,
  MiddlewareFactories extends RouterFactories,
> extends HyperlaneRouterDeployer<
  Chain,
  MiddlewareRouterConfig,
  MiddlewareRouterContracts,
  MiddlewareFactories
> {
  constructor(
    multiProvider: MultiProvider<Chain>,
    configMap: ChainMap<Chain, MiddlewareRouterConfig>,
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
    chain: Chain,
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
    const chainConnection = this.multiProvider.getChainConnection(chain);
    await chainConnection.handleTx(proxyAdmin.transferOwnership(config.owner));
    return {
      proxyAdmin,
      proxiedRouter,
      router: proxiedRouter.contract, // for backwards compatibility
    } as any;
  }
}

type InterchainAccountConfig = RouterConfig;

export class InterchainAccountDeployer<
  Chain extends ChainName,
> extends MiddlewareRouterDeployer<
  Chain,
  RouterConfig,
  InterchainAccountContracts,
  InterchainAccountFactories
> {
  constructor(
    multiProvider: MultiProvider<Chain>,
    configMap: ChainMap<Chain, InterchainAccountConfig>,
    create2salt = 'accountsrouter',
  ) {
    super(multiProvider, configMap, interchainAccountFactories, create2salt);
  }
}

type InterchainQueryConfig = RouterConfig;

export class InterchainQueryDeployer<
  Chain extends ChainName,
> extends MiddlewareRouterDeployer<
  Chain,
  RouterConfig,
  InterchainQueryContracts,
  InterchainQueryFactories
> {
  constructor(
    multiProvider: MultiProvider<Chain>,
    configMap: ChainMap<Chain, InterchainQueryConfig>,
    create2salt = 'queryrouter',
  ) {
    super(multiProvider, configMap, interchainQueryFactories, create2salt);
  }
}
