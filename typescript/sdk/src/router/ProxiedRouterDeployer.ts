import { constants } from 'ethers';

import {
  Router,
  TimelockController,
  TimelockController__factory,
} from '@hyperlane-xyz/core';
import { eqAddress } from '@hyperlane-xyz/utils';

import { HyperlaneContracts } from '../contracts/types.js';
import { resolveOrDeployAccountOwner } from '../deploy/types.js';
import { ChainName } from '../types.js';

import { HyperlaneRouterDeployer } from './HyperlaneRouterDeployer.js';
import { ProxiedFactories, ProxiedRouterConfig } from './types.js';

export abstract class ProxiedRouterDeployer<
  Config extends ProxiedRouterConfig,
  Factories extends ProxiedFactories,
> extends HyperlaneRouterDeployer<Config, Factories> {
  abstract router(contracts: HyperlaneContracts<Factories>): Router;

  /**
   * Returns the contract name
   * @param config Router config
   */
  abstract routerContractName(config: Config): string;

  /**
   * Returns the contract key
   * @param config Router config
   */
  abstract routerContractKey(config: Config): keyof Factories;

  /**
   * Returns the constructor arguments for the proxy
   * @param chain Name of chain
   * @param config Router config
   */
  abstract constructorArgs<RouterKey extends keyof Factories>(
    chain: ChainName,
    config: Config,
  ): Promise<Parameters<Factories[RouterKey]['deploy']>>;

  /**
   * Returns the initialize arguments for the proxy
   * @param chain Name of chain
   * @param config Router config
   */
  abstract initializeArgs<RouterKey extends keyof Factories>(
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
      adminOwner = await resolveOrDeployAccountOwner(
        this.multiProvider,
        chain,
        config.owner,
      );
    }

    await super.runIfOwner(chain, proxyAdmin, async () => {
      this.logger.debug(`Checking ownership of proxy admin to ${adminOwner}`);

      if (!eqAddress(await proxyAdmin.owner(), adminOwner)) {
        this.logger.debug(
          `Transferring ownership of proxy admin to ${adminOwner}`,
        );
        return this.multiProvider.handleTx(
          chain,
          proxyAdmin.transferOwnership(adminOwner),
        );
      }
      return;
    });

    const proxiedRouter = await this.deployProxiedContract(
      chain,
      this.routerContractKey(config),
      this.routerContractName(config),
      proxyAdmin.address,
      await this.constructorArgs(chain, config),
      await this.initializeArgs(chain, config),
    );

    return {
      [this.routerContractKey(config)]: proxiedRouter,
      proxyAdmin,
      timelockController,
    } as HyperlaneContracts<Factories>;
  }
}
