import { expect } from 'chai';

import { AbacusApp, ChainName, chainMetadata } from '@abacus-network/sdk';
import { types, utils } from '@abacus-network/utils';

import { AbacusAppChecker, Ownable } from '../check';

import { Router, RouterConfig } from './types';

export abstract class AbacusRouterChecker<
  Chain extends ChainName,
  App extends AbacusApp<any, Chain>,
  Config extends RouterConfig & {
    owner: types.Address;
  },
> extends AbacusAppChecker<Chain, App, Config> {
  abstract mustGetRouter(chain: Chain): Router; // TODO: implement on AbacusRouterApp

  checkOwnership(chain: Chain) {
    const owner = this.configMap[chain].owner;
    const ownables = this.ownables(chain);
    return AbacusAppChecker.checkOwnership(owner, ownables);
  }

  async checkChain(chain: Chain): Promise<void> {
    await this.checkEnrolledRouters(chain);
    await this.checkOwnership(chain);
    await this.checkAbacusConnectionManager(chain);
  }

  async checkEnrolledRouters(chain: Chain): Promise<void> {
    const router = this.mustGetRouter(chain);

    await Promise.all(
      this.app.remotes(chain).map(async (remoteNetwork) => {
        const remoteRouter = this.mustGetRouter(remoteNetwork);
        const remoteChainId = chainMetadata[remoteNetwork].id;
        expect(await router.routers(remoteChainId)).to.equal(
          utils.addressToBytes32(remoteRouter.address),
        );
      }),
    );
  }

  ownables(chain: Chain): Ownable[] {
    const ownables: Ownable[] = [this.mustGetRouter(chain)];
    const config = this.configMap[chain];
    // If the config specifies that an abacusConnectionManager should have been deployed,
    // it should be owned by the owner.
    if (config.abacusConnectionManager) {
      const contracts: any = this.app.getContracts(chain);
      ownables.push(contracts.abacusConnectionManager);
    }
    return ownables;
  }

  async checkAbacusConnectionManager(chain: Chain): Promise<void> {
    const config = this.configMap[chain];
    if (!config.abacusConnectionManager) {
      return;
    }
    const actual = await this.mustGetRouter(chain).abacusConnectionManager();
    expect(actual).to.equal(config.abacusConnectionManager);
  }
}
