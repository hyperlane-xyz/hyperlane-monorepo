import { expect } from 'chai';

import {
  AbacusApp,
  ChainName,
  RouterContracts,
  chainMetadata,
} from '@abacus-network/sdk';
import { utils } from '@abacus-network/utils';

import { AbacusAppChecker, Ownable } from '../check';

import { RouterConfig } from './types';

export class AbacusRouterChecker<
  Chain extends ChainName,
  Contracts extends RouterContracts,
  App extends AbacusApp<Contracts, Chain>,
  Config extends RouterConfig,
> extends AbacusAppChecker<Chain, App, Config> {
  checkOwnership(chain: Chain) {
    const owner = this.configMap[chain].owner;
    const ownables = this.ownables(chain);
    return AbacusAppChecker.checkOwnership(owner, ownables);
  }

  async checkChain(chain: Chain): Promise<void> {
    await this.checkEnrolledRouters(chain);
    await this.checkOwnership(chain);
  }

  async checkEnrolledRouters(chain: Chain): Promise<void> {
    const router = this.app.getContracts(chain).router;

    await Promise.all(
      this.app.remoteChains(chain).map(async (remoteNetwork) => {
        const remoteRouter = this.app.getContracts(remoteNetwork).router;
        const remoteChainId = chainMetadata[remoteNetwork].id;
        expect(await router.routers(remoteChainId)).to.equal(
          utils.addressToBytes32(remoteRouter.address),
        );
      }),
    );
  }

  ownables(chain: Chain): Ownable[] {
    return [this.app.getContracts(chain).router];
  }
}
