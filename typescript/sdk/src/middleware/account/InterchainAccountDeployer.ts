import {
  InterchainAccountRouter,
  ProxyAdmin,
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

export type InterchainAccountConfig = RouterConfig;

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
    const proxyAdmin = (await this.deployContract(
      chain,
      'proxyAdmin',
      [],
    )) as ProxyAdmin;

    // adapted from HyperlaneDeployer.deployProxiedContract
    const cached = this.deployedContracts[chain]
      ?.interchainAccountRouter as ProxiedContract<InterchainAccountRouter>;
    if (cached && cached.addresses.proxy && cached.addresses.implementation) {
      this.logger('Recovered full InterchainAccountRouter');
      return {
        proxyAdmin,
        proxiedRouter: cached,
        interchainAccountRouter: cached, // for serialization
        router: cached.contract, // for backwards compatibility
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
      router: proxiedRouter.contract, // for backwards compatibility
      interchainAccountRouter: proxiedRouter, // for serialization
    };
  }
}
