import { constants } from 'ethers';

import {
  Router,
  TimelockController,
  TimelockController__factory,
} from '@hyperlane-xyz/core';
import { eqAddress } from '@hyperlane-xyz/utils';

import { HyperlaneContracts } from '../contracts/types';
import { ChainName } from '../types';

import { HyperlaneRouterDeployer } from './HyperlaneRouterDeployer';
import { ProxiedFactories, ProxiedRouterConfig } from './types';

export abstract class ProxiedRouterDeployer<
  Config extends ProxiedRouterConfig,
  Factories extends ProxiedFactories,
  RouterKey extends keyof Factories,
> extends HyperlaneRouterDeployer<Config, Factories> {
  abstract routerContractNameConstant: RouterKey; // @dev this is for backwards compatibility, should refactor later

  router(contracts: HyperlaneContracts<Factories>): Router {
    return contracts[this.routerContractNameConstant] as Router;
  }

  /**
   * Returns the contract name
   * @param config Router config
   */
  abstract routerContractName(config: Config): RouterKey;

  /**
   * Returns the constructor arguments for the proxy
   * @param chain Name of chain
   * @param config Router config
   */
  abstract constructorArgs(
    chain: ChainName,
    config: Config,
  ): Promise<Parameters<Factories[RouterKey]['deploy']>>;

  /**
   * Returns the initialize arguments for the proxy
   * @param chain Name of chain
   * @param config Router config
   */
  abstract initializeArgs(
    chain: ChainName,
    config: Config,
  ): Promise<
    Parameters<
      Awaited<ReturnType<Factories[RouterKey]['deploy']>>['initialize']
    >
  >;

  async deployContracts(
    chain: ChainName,
    config: Config,
  ): Promise<HyperlaneContracts<Factories>> {
    const proxyAdmin = await this.deployContractFromFactory(
      chain,
      this.factories.proxyAdmin,
      'proxyAdmin',
      [],
    );

    let timelockController: TimelockController;
    let adminOwner: string;
    if (config.timelock) {
      timelockController = await this.deployTimelock(chain, config.timelock);
      adminOwner = timelockController.address;
    } else {
      timelockController = TimelockController__factory.connect(
        constants.AddressZero,
        this.multiProvider.getProvider(chain),
      );
      adminOwner = config.owner;
    }

    await super.runIfOwner(chain, proxyAdmin, async () => {
      this.logger(`Checking ownership of proxy admin to ${adminOwner}`);

      if (!eqAddress(await proxyAdmin.owner(), adminOwner)) {
        this.logger(`Transferring ownership of proxy admin to ${adminOwner}`);
        return this.multiProvider.handleTx(
          chain,
          proxyAdmin.transferOwnership(adminOwner),
        );
      }
      return;
    });

    const proxiedRouter = await this.deployProxiedContract(
      chain,
      this.routerContractName(config),
      proxyAdmin.address,
      await this.constructorArgs(chain, config),
      await this.initializeArgs(chain, config),
    );

    return {
      [this.routerContractName(config)]: proxiedRouter,
      proxyAdmin,
      timelockController,
    } as HyperlaneContracts<Factories>;
  }
}
