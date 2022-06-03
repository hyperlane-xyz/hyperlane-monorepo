import { expect } from 'chai';

import { Router } from '@abacus-network/app';
import {
  AbacusApp,
  ChainName,
  ProxiedContract,
  RouterContracts,
  chainMetadata,
} from '@abacus-network/sdk';
import { utils } from '@abacus-network/utils';

import { AbacusAppChecker, Ownable } from '../check';

import { RouterConfig } from './types';

export class AbacusRouterChecker<
  Chain extends ChainName,
  App extends AbacusApp<RouterContracts, Chain>,
  Config extends RouterConfig,
> extends AbacusAppChecker<Chain, App, Config> {
  checkOwnership(chain: Chain) {
    const owner = this.configMap[chain].owner;
    const ownables = this.ownables(chain);
    return AbacusAppChecker.checkOwnership(owner, ownables);
  }

  getRouterInstance(router: Router | ProxiedContract<Router, any>) {
    return router instanceof ProxiedContract ? router.contract : router;
  }

  async checkChain(chain: Chain): Promise<void> {
    await this.checkEnrolledRouters(chain);
    await this.checkOwnership(chain);
  }

  async checkEnrolledRouters(chain: Chain): Promise<void> {
    const router = this.getRouterInstance(this.app.getContracts(chain).router);

    await Promise.all(
      this.app.remoteChains(chain).map(async (remoteNetwork) => {
        const remoteRouter = this.getRouterInstance(
          this.app.getContracts(remoteNetwork).router,
        );
        const remoteChainId = chainMetadata[remoteNetwork].id;
        expect(await router.routers(remoteChainId)).to.equal(
          utils.addressToBytes32(remoteRouter.address),
        );
      }),
    );
  }

  ownables(chain: Chain): Ownable[] {
    const contracts = this.app.getContracts(chain);
    const ownables: Ownable[] = [this.getRouterInstance(contracts.router)];
    return ownables;
  }
}
