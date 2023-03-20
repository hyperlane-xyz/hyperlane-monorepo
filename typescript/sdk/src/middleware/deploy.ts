import { ethers } from 'ethers';

import {
  ProxyAdmin__factory,
  TransparentUpgradeableProxy__factory,
} from '@hyperlane-xyz/core';
import {
  InterchainAccountRouter,
  InterchainAccountRouter__factory,
  InterchainQueryRouter,
  InterchainQueryRouter__factory,
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
    _: MiddlewareRouterConfig,
  ): Parameters<MiddlewareFactories['router']['deploy']> {
    return [] as any;
  }

  async initializeArgs(
    chain: ChainName,
    config: MiddlewareRouterConfig,
  ): Promise<any> {
    const signer = await this.multiProvider.getSignerAddress(chain);
    return [
      config.mailbox,
      config.interchainGasPaymaster,
      config.interchainSecurityModule ?? ethers.constants.AddressZero,
      signer, // set signer as owner for subsequent initialization calls
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
      this.constructorArgs(config),
      proxyAdmin,
      initArgs,
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
    create2Salt = 'accountsrouter',
  ) {
    super(multiProvider, configMap, interchainAccountFactories, create2Salt);
  }

  async deployContracts(
    chain: ChainName,
    config: InterchainAccountConfig,
  ): Promise<InterchainAccountContracts> {
    // adapted from super.deployProxy to use a dummy implementation
    const proxyAdmin = await this.deployContractFromFactory(
      chain,
      new ProxyAdmin__factory(),
      'proxyAdmin',
      [],
      { create2Salt: this.create2salt },
    );

    // deploy proxy with dummy implementation and skip initialize
    const proxy = await this.deployContractFromFactory(
      chain,
      new TransparentUpgradeableProxy__factory(),
      'proxy',
      [proxyAdmin.address, proxyAdmin.address, '0x'],
      { create2Salt: this.create2salt },
    );

    const implementation = await this.deployContract(
      chain,
      'router',
      [proxy.address],
      { create2Salt: this.create2salt },
    );

    // upgrade proxy to real implementation and initialize
    const initData = this.factories.router.interface.encodeFunctionData(
      'initialize',
      await this.initializeArgs(chain, config),
    );
    await this.multiProvider.handleTx(
      chain,
      proxyAdmin.upgradeAndCall(
        proxy.address,
        implementation.address,
        initData,
      ),
    );

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
    } as any;
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
