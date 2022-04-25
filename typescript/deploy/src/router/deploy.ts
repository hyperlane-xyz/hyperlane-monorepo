import {
  XAppConnectionManager,
  XAppConnectionManager__factory,
} from '@abacus-network/core';
import {
  AbacusCore,
  ChainName,
  ChainSubsetMap,
  MultiProvider,
} from '@abacus-network/sdk';
import { utils } from '@abacus-network/utils';
import { AbacusAppDeployer } from '../deploy';
import { Router, RouterConfig } from './types';

export abstract class AbacusRouterDeployer<
  N extends ChainName,
  C extends RouterConfig,
  A,
> extends AbacusAppDeployer<N, C, A> {
  protected core?: AbacusCore;

  abstract mustGetRouter(network: ChainName): Router;

  constructor(
    multiProvider: MultiProvider<N>,
    configMap: ChainSubsetMap<N, C>,
    core?: AbacusCore,
  ) {
    super(multiProvider, configMap);
    this.core = core;
  }

  async deploy() {
    const deploymentOutput = await super.deploy();

    // Make all routers aware of eachother.
    const networks = Object.keys(deploymentOutput) as N[];
    for (const local of networks) {
      const localRouter = this.mustGetRouter(local);
      for (const remote of this.multiProvider.remotes(local)) {
        const remoteRouter = this.mustGetRouter(remote);
        await localRouter.enrollRemoteRouter(
          remote,
          utils.addressToBytes32(remoteRouter.address),
        );
      }
    }
    return deploymentOutput;
  }

  async deployConnectionManagerIfNotConfigured(
    network: N,
  ): Promise<XAppConnectionManager> {
    const dc = this.multiProvider.getDomainConnection(network);
    const signer = dc.signer!;
    const config = this.configMap[network];
    if (config.xAppConnectionManager) {
      return XAppConnectionManager__factory.connect(
        config.xAppConnectionManager,
        signer,
      );
    }

    const xAppConnectionManager = await this.deployContract(
      network,
      'XAppConnectionManager',
      new XAppConnectionManager__factory(signer),
      [],
    );
    const overrides = dc.overrides;
    if (!this.core)
      throw new Error('must set core or configure xAppConnectionManager');
    const localCore = this.core.getContracts(network);
    await xAppConnectionManager.contract.setOutbox(
      localCore.getOutbox().address,
      overrides,
    );
    for (const remote of this.core.remotes(network)) {
      await xAppConnectionManager.contract.enrollInbox(
        remote,
        localCore.getInbox(remote).address,
        overrides,
      );
    }
    return xAppConnectionManager.contract; // TODO: persist verificationInput
  }
}
