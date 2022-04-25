import {
  AbacusApp,
  ChainName,
  ChainSubsetMap,
  domains,
  MultiProvider,
} from '@abacus-network/sdk';
import { types, utils } from '@abacus-network/utils';
import { expect } from 'chai';
import { AbacusAppChecker, Ownable } from '../check';
import { Router, RouterConfig } from './types';

export abstract class AbacusRouterChecker<
  N extends ChainName,
  A extends AbacusApp<any, N>,
> extends AbacusAppChecker<A> {
  abstract mustGetRouter(network: N): Router; // TODO: implement on AbacusRouterApp

  constructor(
    multiProvider: MultiProvider,
    app: A,
    protected config: ChainSubsetMap<N, RouterConfig>,
  ) {
    super(multiProvider, app);
  }

  async check(owners: ChainSubsetMap<N, types.Address> | types.Address) {
    const networks = this.app.networks();
    return Promise.all(
      networks.map((network) => {
        let owner: types.Address =
          typeof owners === 'string' ? owners : owners[network];
        this.checkDomain(network, owner);
      }),
    );
  }

  async checkDomain(network: N, owner: types.Address): Promise<void> {
    await this.checkEnrolledRouters(network);
    await this.checkOwnership(owner, this.ownables(network));
    await this.checkXAppConnectionManager(network);
  }

  async checkEnrolledRouters(network: N): Promise<void> {
    const router = this.mustGetRouter(network);

    await Promise.all(
      this.app.remotes(network).map(async (remoteNetwork) => {
        const remoteRouter = this.mustGetRouter(remoteNetwork);
        const remoteChainId = domains[remoteNetwork as ChainName].id; // TODO: remove cast
        expect(await router.routers(remoteChainId)).to.equal(
          utils.addressToBytes32(remoteRouter.address),
        );
      }),
    );
  }

  ownables(network: N): Ownable[] {
    const ownables: Ownable[] = [this.mustGetRouter(network)];
    // If the config specifies that a xAppConnectionManager should have been deployed,
    // it should be owned by the owner.
    if (!this.config[network].xAppConnectionManager) {
      const contracts = this.app.getContracts(network);
      ownables.push(contracts.xAppConectionManager);
    }
    return ownables;
  }

  async checkXAppConnectionManager(network: N): Promise<void> {
    if (this.config[network].xAppConnectionManager === undefined) return;
    const actual = await this.mustGetRouter(network).xAppConnectionManager();
    const expected = this.config[network].xAppConnectionManager;
    expect(actual).to.equal(expected);
  }
}
