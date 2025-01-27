import { constants } from 'ethers';

import {
  ProxyAdmin,
  ProxyAdmin__factory,
  Router,
  TimelockController,
  TimelockController__factory,
} from '@hyperlane-xyz/core';
import { eqAddress } from '@hyperlane-xyz/utils';

import { HyperlaneContracts, HyperlaneFactories } from '../contracts/types.js';
import { DeployerOptions } from '../deploy/HyperlaneDeployer.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { ChainName } from '../types.js';

import { HyperlaneRouterDeployer } from './HyperlaneRouterDeployer.js';
import {
  ProxiedFactories,
  ProxiedRouterConfig,
  proxiedFactories,
} from './types.js';

export abstract class ProxiedRouterDeployer<
  Config extends ProxiedRouterConfig,
  Factories extends HyperlaneFactories,
> extends HyperlaneRouterDeployer<Config, Factories & ProxiedFactories> {
  constructor(
    multiProvider: MultiProvider,
    factories: Factories,
    options?: DeployerOptions,
  ) {
    super(
      multiProvider,
      {
        ...factories,
        ...proxiedFactories,
      },
      options,
    );
  }

  abstract router(
    contracts: HyperlaneContracts<Factories & ProxiedFactories>,
  ): Router;

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
  ): Promise<HyperlaneContracts<Factories & ProxiedFactories>> {
    let proxyAdmin: ProxyAdmin;
    if (config.proxyAdmin?.address) {
      this.logger.debug(
        `Reusing existing ProxyAdmin at ${config.proxyAdmin.address} for chain ${chain}`,
      );
      proxyAdmin = ProxyAdmin__factory.connect(
        config.proxyAdmin.address,
        this.multiProvider.getSigner(chain),
      );
    } else {
      this.logger.debug(
        `A ProxyAdmin config has not been supplied for chain ${chain}, deploying a new contract`,
      );

      proxyAdmin = await this.deployContractFromFactory(
        chain,
        this.factories.proxyAdmin,
        'proxyAdmin',
        [],
      );
    }

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
      this.logger.debug(`Checking ownership of proxy admin to ${adminOwner}`);

      if (!eqAddress(await proxyAdmin.owner(), adminOwner)) {
        this.logger.debug(
          `Transferring ownership of proxy admin to ${adminOwner}`,
        );
        return this.multiProvider.handleTx(
          chain,
          proxyAdmin.transferOwnership(
            adminOwner,
            this.multiProvider.getTransactionOverrides(chain),
          ),
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
    } as HyperlaneContracts<Factories & ProxiedFactories>;
  }
}
