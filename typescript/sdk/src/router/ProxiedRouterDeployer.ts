import { Router } from '@hyperlane-xyz/core';

import { HyperlaneContracts } from '../contracts';
import { ChainName } from '../types';

import { HyperlaneRouterDeployer } from './HyperlaneRouterDeployer';
import { ProxiedFactories, RouterConfig } from './types';

export abstract class ProxiedRouterDeployer<
  Config extends RouterConfig,
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

    const proxiedRouter = await this.deployProxiedContract(
      chain,
      this.routerContractName,
      await this.constructorArgs(chain, config),
      await this.initializeArgs(chain, config),
      proxyAdmin.address,
    );

    this.logger(`Transferring ownership of proxy admin to ${config.owner}`);
    await super.runIfOwner(chain, proxyAdmin, () =>
      this.multiProvider.handleTx(
        chain,
        proxyAdmin.transferOwnership(config.owner),
      ),
    );

    return {
      [this.routerContractName]: proxiedRouter,
      proxyAdmin,
    } as HyperlaneContracts<Factories>;
  }
}
