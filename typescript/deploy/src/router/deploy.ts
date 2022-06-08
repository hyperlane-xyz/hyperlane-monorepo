import { debug } from 'debug';

import { Router } from '@abacus-network/app';
import {
  ChainMap,
  ChainName,
  MultiProvider,
  ProxiedContract,
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
  Config extends {
    router: RouterConfig<Contracts['router'], Factories['router']>;
  },
> extends AbacusDeployer<Chain, Config, Factories, Contracts> {
  constructor(
    multiProvider: MultiProvider<Chain>,
    configMap: ChainMap<Chain, Config & RouterConfig>,
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

  async deployRouter(
    chain: Chain,
    config: Config['router'],
  ): Promise<Contracts['router']> {
    const router = (await this.deployContract(
      chain,
      'router',
      config.deployParams,
    )) as Contracts['router'];
    // @ts-ignore spread operator
    await router.initialize(...config.initParams);
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
            utils.addressToBytes32(
              this.getRouterInstance(contractsMap[remote]).address,
            ),
          );
        }
      }),
    );
  }

  async transferOwnership(contractsMap: ChainMap<Chain, Contracts>) {
    this.logger(`Transfer ownership of routers to owner ...`);
    await promiseObjAll(
      objMap(contractsMap, async (chain, contracts) =>
        this.getRouterInstance(contracts).transferOwnership(
          this.configMap[chain].owner,
        ),
      ),
    );
  }

  async deploy() {
    const contractsMap = await super.deploy();

    await this.enrollRemoteRouters(contractsMap);
    await this.transferOwnership(contractsMap);

    return contractsMap;
  }
}
