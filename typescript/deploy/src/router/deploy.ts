import {
  AbacusConnectionManager,
  AbacusConnectionManager__factory,
} from '@abacus-network/core';
import {
  AbacusCore,
  ChainMap,
  ChainName,
  MultiProvider,
  chainMetadata,
  objMap,
  promiseObjAll,
} from '@abacus-network/sdk';
import { utils } from '@abacus-network/utils';

import { AbacusAppDeployer } from '../deploy';

import { Router, RouterConfig } from './types';

export abstract class AbacusRouterDeployer<
  Chain extends ChainName,
  Config extends RouterConfig,
  Addresses,
> extends AbacusAppDeployer<Chain, Config, Addresses> {
  protected core?: AbacusCore<Chain>;

  abstract mustGetRouter(chain: Chain, addresses: Addresses): Router;

  constructor(
    multiProvider: MultiProvider<Chain>,
    configMap: ChainMap<Chain, Config>,
    core?: AbacusCore<Chain>,
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
        for (const remote of this.multiProvider.remoteChains(local)) {
          const remoteRouter = this.mustGetRouter(
            remote,
            deploymentOutput[remote],
          );
          await localRouter.enrollRemoteRouter(
            chainMetadata[remote].id,
            utils.addressToBytes32(remoteRouter.address),
          );
        }
      }),
    );

    return deploymentOutput;
  }

  async deployConnectionManagerIfNotConfigured(
    chain: Chain,
  ): Promise<AbacusConnectionManager> {
    const dc = this.multiProvider.getChainConnection(chain);
    const signer = dc.signer!;
    const config = this.configMap[chain];
    if (config.abacusConnectionManager) {
      return AbacusConnectionManager__factory.connect(
        config.abacusConnectionManager,
        signer,
      );
    }

    const abacusConnectionManager = await this.deployContract(
      chain,
      'AbacusConnectionManager',
      new AbacusConnectionManager__factory(signer),
      [],
    );
    const overrides = dc.overrides;
    if (!this.core)
      throw new Error('must set core or configure abacusConnectionManager');
    const localCore = this.core.getContracts(chain);
    await abacusConnectionManager.setOutbox(
      localCore.outbox.outbox.address,
      overrides,
    );
    for (const remote of this.core.remoteChains(chain)) {
      await abacusConnectionManager.enrollInbox(
        chainMetadata[remote].id,
        localCore.inboxes[remote].inbox.address,
        overrides,
      );
    }
    return abacusConnectionManager;
  }
}
