import { ethers } from 'ethers';

import {
  Router,
  TransparentUpgradeableProxy__factory,
} from '@hyperlane-xyz/core';

import { HyperlaneContracts } from '../../contracts';
import { MultiProvider } from '../../providers/MultiProvider';
import { HyperlaneRouterDeployer } from '../../router/HyperlaneRouterDeployer';
import { RouterConfig } from '../../router/types';
import { ChainName } from '../../types';

import {
  InterchainAccountFactories,
  interchainAccountFactories,
} from './contracts';

export type InterchainAccountConfig = RouterConfig;

export class InterchainAccountDeployer extends HyperlaneRouterDeployer<
  InterchainAccountConfig,
  InterchainAccountFactories
> {
  constructor(multiProvider: MultiProvider) {
    super(multiProvider, interchainAccountFactories, {});
  }

  router(contracts: HyperlaneContracts<InterchainAccountFactories>): Router {
    return contracts.interchainAccountRouter;
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
    await super.upgradeAndInitialize(chain, proxy, implementation, [
      config.mailbox,
      config.interchainGasPaymaster,
      config.interchainSecurityModule ?? ethers.constants.AddressZero,
      deployer,
    ]);
    await super.changeAdmin(chain, proxy, proxyAdmin.address);

    const interchainAccountRouter = implementation.attach(proxy.address);

    return {
      proxyAdmin,
      interchainAccountRouter,
    };
  }
}
