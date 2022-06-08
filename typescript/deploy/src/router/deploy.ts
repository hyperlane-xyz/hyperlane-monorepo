import { debug } from 'debug';

import {
  ChainMap,
  ChainName,
  MultiProvider,
  ProxiedContract,
  Router,
  RouterContracts,
  RouterFactories,
  chainMetadata,
  objMap,
  promiseObjAll,
} from '@abacus-network/sdk';
import { utils } from '@abacus-network/utils';

import { AbacusDeployer, DeployerOptions } from '../deploy';

import { RouterConfig } from './types';

export abstract class AbacusRouterDeployer<
  Chain extends ChainName,
  Contracts extends RouterContracts,
  Factories extends RouterFactories,
  Config extends RouterConfig,
> extends AbacusDeployer<Chain, Config, Factories, Contracts> {
  constructor(
    multiProvider: MultiProvider<Chain>,
    configMap: ChainMap<Chain, Config>,
    factories: Factories,
    options?: DeployerOptions,
  ) {
    const logger = options?.logger || debug('abacus:RouterDeployer');
    super(multiProvider, configMap, factories, { ...options, logger });
  }

  getRouterInstance(contracts: Contracts): Router {
    const router = contracts.router;
    return router instanceof ProxiedContract ? router.contract : router;
  }

  // for use in implementations of deployContracts
  async deployRouter<RouterContract extends Router>(
    chain: Chain,
    deployParams: Parameters<Factories['router']['deploy']>,
    initParams: Parameters<RouterContract['initialize']>,
  ): Promise<Contracts['router']> {
    const router = await this.deployContract(chain, 'router', deployParams);
    this.logger(`Initializing ${chain}'s router with ${initParams}`);
    // @ts-ignore spread operator
    await router.initialize(...initParams);
    return router;
  }

  async enrollRemoteRouters(contractsMap: ChainMap<Chain, Contracts>) {
    this.logger(`Enrolling deployed routers with each other...`);
    // Make all routers aware of eachother.
    await promiseObjAll(
      objMap(contractsMap, async (local, contracts) => {
        for (const remote of this.multiProvider.remoteChains(local)) {
          this.logger(`Enroll ${remote}'s router on ${local}`);
          await this.getRouterInstance(contracts).enrollRemoteRouter(
            chainMetadata[remote].id,
            utils.addressToBytes32(contractsMap[remote].router.address),
          );
        }
      }),
    );
  }

  async transferOwnership(contractsMap: ChainMap<Chain, Contracts>) {
    // TODO: check for initialization before transferring ownership
    this.logger(`Transferring ownership of routers...`);
    await promiseObjAll(
      objMap(contractsMap, async (chain, contracts) => {
        const owner = this.configMap[chain].owner;
        this.logger(`Transfer ownership of ${chain}'s router to ${owner}`);
        await this.getRouterInstance(contracts).transferOwnership(owner);
      }),
    );
  }

  async deploy() {
    const contractsMap = await super.deploy();

    await this.enrollRemoteRouters(contractsMap);
    await this.transferOwnership(contractsMap);

    return contractsMap;
  }
}
