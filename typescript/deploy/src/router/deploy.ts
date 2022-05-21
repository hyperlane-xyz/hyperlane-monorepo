import { debug } from 'debug';

import {
  ChainMap,
  ChainName,
  MultiProvider,
  chainMetadata,
  objMap,
  promiseObjAll,
} from '@abacus-network/sdk';
import { utils } from '@abacus-network/utils';

import { AbacusAppDeployer, DeployerOptions } from '../deploy';

import { Router, RouterConfig } from './types';

export abstract class AbacusRouterDeployer<
  Chain extends ChainName,
  Config,
  Addresses,
> extends AbacusAppDeployer<Chain, Config & RouterConfig, Addresses> {
  abstract mustGetRouter(chain: Chain, addresses: Addresses): Router;

  constructor(
    multiProvider: MultiProvider<Chain>,
    configMap: ChainMap<Chain, Config & RouterConfig>,
    options?: DeployerOptions,
  ) {
    const logger = options?.logger || debug('abacus:RouterDeployer');
    super(multiProvider, configMap, { ...options, logger });
  }

  async deploy() {
    const deploymentOutput = await super.deploy();

    this.logger(`Enroll Routers with each other`);
    // Make all routers aware of eachother.
    await promiseObjAll(
      objMap(deploymentOutput, async (local, addresses) => {
        const localRouter = this.mustGetRouter(local, addresses);
        for (const remote of this.multiProvider.remoteChains(local)) {
          const remoteRouter = this.mustGetRouter(
            remote,
            deploymentOutput[remote],
          );
          this.logger(`Enroll ${remote}'s router on ${local}`);
          await localRouter.enrollRemoteRouter(
            chainMetadata[remote].id,
            utils.addressToBytes32(remoteRouter.address),
          );
        }
      }),
    );

    return deploymentOutput;
  }
}
