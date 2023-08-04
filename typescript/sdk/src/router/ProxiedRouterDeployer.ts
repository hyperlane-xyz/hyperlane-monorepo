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
  abstract routerContractName: RouterKey;

  router(contracts: HyperlaneContracts<Factories>): Router {
    return contracts[this.routerContractName] as Router;
  }

  abstract constructorArgs(
    chain: ChainName,
    config: Config,
  ): Promise<Parameters<Factories[RouterKey]['deploy']>>;

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
      this.routerContractName,
      proxyAdmin.address,
      await this.constructorArgs(chain, config),
      await this.initializeArgs(chain, config),
    );

    return {
      [this.routerContractName]: proxiedRouter,
      proxyAdmin,
      timelockController,
    } as HyperlaneContracts<Factories>;
  }
}
