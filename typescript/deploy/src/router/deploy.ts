import {
  AbacusConnectionManager,
  AbacusConnectionManager__factory,
} from '@abacus-network/core';
import {
  AbacusCore,
  ChainMap,
  ChainName,
  MultiProvider,
  RouterAddresses,
  domains,
  objMap,
  promiseObjAll,
} from '@abacus-network/sdk';
import { utils } from '@abacus-network/utils';

import { AbacusAppDeployer } from '../deploy';

import { Router, RouterConfig } from './types';

export abstract class AbacusRouterDeployer<
  N extends ChainName,
  C extends RouterConfig,
  A extends RouterAddresses,
> extends AbacusAppDeployer<N, C, A> {
  protected core?: AbacusCore<N>;

  abstract mustGetRouter(network: N, addresses: A): Router;

  constructor(
    multiProvider: MultiProvider<N>,
    configMap: ChainMap<N, C>,
    core?: AbacusCore<N>,
  ) {
    super(multiProvider, configMap);
    this.core = core;
  }

  async deploy() {
    const deploymentOutput = await super.deploy();

    // Make all routers aware of eachother.
    await promiseObjAll(
      objMap(deploymentOutput, async (local, addresses) => {
        const localRouter = this.mustGetRouter(local, addresses);
        for (const remote of this.multiProvider.remotes(local)) {
          const remoteRouter = this.mustGetRouter(
            remote,
            deploymentOutput[remote],
          );
          await localRouter.enrollRemoteRouter(
            domains[remote].id,
            utils.addressToBytes32(remoteRouter.address),
          );
        }
      }),
    );

    return deploymentOutput;
  }

  async deployConnectionManagerIfNotConfigured(
    network: N,
  ): Promise<AbacusConnectionManager> {
    const dc = this.multiProvider.getDomainConnection(network);
    const signer = dc.signer!;
    const config = this.configMap[network];
    if (config.abacusConnectionManager) {
      return AbacusConnectionManager__factory.connect(
        config.abacusConnectionManager,
        signer,
      );
    }

    const abacusConnectionManager = await this.deployContract(
      network,
      'AbacusConnectionManager',
      new AbacusConnectionManager__factory(signer),
      [],
    );
    const overrides = dc.overrides;
    if (!this.core)
      throw new Error('must set core or configure abacusConnectionManager');
    const localCore = this.core.getContracts(network);
    await abacusConnectionManager.setOutbox(
      localCore.outbox.outbox.address,
      overrides,
    );
    for (const remote of this.core.remotes(network)) {
      await abacusConnectionManager.enrollInbox(
        domains[remote].id,
        localCore.inboxes[remote].inbox.address,
        overrides,
      );
    }
    return abacusConnectionManager;
  }
}
