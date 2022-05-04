import { expect } from 'chai';

import { AbacusApp, ChainMap, ChainName, domains } from '@abacus-network/sdk';
import { types, utils } from '@abacus-network/utils';

import { AbacusAppChecker, Ownable } from '../check';

import { Router, RouterConfig } from './types';

export abstract class AbacusRouterChecker<
  Networks extends ChainName,
  App extends AbacusApp<any, Networks>,
  Config extends RouterConfig<Networks> & {
    owners: ChainMap<Networks, types.Address>;
  },
> extends AbacusAppChecker<Networks, App, Config> {
  abstract mustGetRouter(network: Networks): Router; // TODO: implement on AbacusRouterApp

  checkOwnership(network: Networks) {
    const owner = this.config.owners[network];
    const ownables = this.ownables(network);
    return AbacusAppChecker.checkOwnership(owner, ownables);
  }

  async checkDomain(network: Networks): Promise<void> {
    await this.checkEnrolledRouters(network);
    await this.checkOwnership(network);
    await this.checkAbacusConnectionManager(network);
  }

  async checkEnrolledRouters(network: Networks): Promise<void> {
    const router = this.mustGetRouter(network);

    await Promise.all(
      this.app.remotes(network).map(async (remoteNetwork) => {
        const remoteRouter = this.mustGetRouter(remoteNetwork);
        const remoteChainId = domains[remoteNetwork as Networks].id; // TODO: remove cast
        expect(await router.routers(remoteChainId)).to.equal(
          utils.addressToBytes32(remoteRouter.address),
        );
      }),
    );
  }

  ownables(network: Networks): Ownable[] {
    const ownables: Ownable[] = [this.mustGetRouter(network)];
    // If the config specifies that an abacusConnectionManager should have been deployed,
    // it should be owned by the owner.
    if (
      this.config.abacusConnectionManager &&
      this.config.abacusConnectionManager[network] === undefined
    ) {
      const contracts: any = this.app.getContracts(network);
      ownables.push(contracts.abacusConnectionManager);
    }
    return ownables;
  }

  async checkAbacusConnectionManager(network: Networks): Promise<void> {
    if (
      this.config.abacusConnectionManager &&
      this.config.abacusConnectionManager[network] === undefined
    ) {
      return;
    }
    const actual = await this.mustGetRouter(network).abacusConnectionManager();
    const expected = this.config.abacusConnectionManager![network];
    expect(actual).to.equal(expected);
  }
}
