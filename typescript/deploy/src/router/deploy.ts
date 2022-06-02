import { debug } from 'debug';

import {
  ChainMap,
  ChainName,
  MultiProvider,
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
  Config extends RouterConfig,
  Factories extends RouterFactories,
  Contracts extends RouterContracts,
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

  async deploy() {
    const contractsMap = await super.deploy();

    this.logger(`Enrolling deployed routers with each other...`);
    // Make all routers aware of eachother.
    await promiseObjAll(
      objMap(contractsMap, async (local, contracts) => {
        for (const remote of this.multiProvider.remoteChains(local)) {
          this.logger(`Enroll ${remote}'s router on ${local}`);
          await contracts.router.enrollRemoteRouter(
            chainMetadata[remote].id,
            utils.addressToBytes32(contractsMap[remote].router.address),
          );
        }
      }),
    );

    return contractsMap;
  }
}
