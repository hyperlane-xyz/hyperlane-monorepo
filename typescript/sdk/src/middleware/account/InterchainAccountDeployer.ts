import {
  InterchainAccountRouter,
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
    if (config.interchainSecurityModule) {
      throw new Error(
        'Configuration of ISM address not supported in ICA deployer',
      );
    }

    const proxyAdmin = await this.deployContract(chain, 'proxyAdmin', []);
    const interchainAccountIsm = await this.deployContract(
      chain,
      'interchainAccountIsm',
      [config.mailbox],
    );

    let interchainAccountRouter: InterchainAccountRouter;
    // adapted from HyperlaneDeployer.deployProxiedContract
    const cachedRouter = this.readCache(
      chain,
      this.factories['interchainAccountRouter'],
      'interchainAccountRouter',
    );

    if (cachedRouter) {
      interchainAccountRouter = cachedRouter;
    } else {
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
      const owner = deployer;
      await super.upgradeAndInitialize(chain, proxy, implementation, [
        config.mailbox,
        config.interchainGasPaymaster,
        interchainAccountIsm.address,
        owner,
      ]);
      interchainAccountRouter = implementation.attach(proxy.address);
      this.writeCache(chain, 'interchainAccountRouter', proxy.address);
    }

    const proxy = TransparentUpgradeableProxy__factory.connect(
      interchainAccountRouter.address,
      this.multiProvider.getSignerOrProvider(chain),
    );

    await super.changeAdmin(chain, proxy, proxyAdmin.address);

    return {
      proxyAdmin,
      interchainAccountIsm,
      interchainAccountRouter,
    };
  }
}
