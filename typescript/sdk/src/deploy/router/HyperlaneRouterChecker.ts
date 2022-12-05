import { Ownable } from '@hyperlane-xyz/core';
import { utils } from '@hyperlane-xyz/utils';

import { HyperlaneApp } from '../../HyperlaneApp';
import { chainMetadata } from '../../consts/chainMetadata';
import { RouterContracts } from '../../router';
import { ChainName } from '../../types';
import { HyperlaneAppChecker } from '../HyperlaneAppChecker';

import {
  EnrolledRouterViolation,
  RouterConfig,
  RouterViolationType,
} from './types';

export class HyperlaneRouterChecker<
  Chain extends ChainName,
  App extends HyperlaneApp<Contracts, Chain>,
  Config extends RouterConfig,
  Contracts extends RouterContracts,
> extends HyperlaneAppChecker<Chain, App, Config> {
  checkOwnership(chain: Chain): Promise<void> {
    const owner = this.configMap[chain].owner;
    const ownables = this.ownables(chain);
    return super.checkOwnership(chain, owner, ownables);
  }

  async checkChain(chain: Chain): Promise<void> {
    await this.checkEnrolledRouters(chain);
    await this.checkOwnership(chain);
  }

  async checkEnrolledRouters(chain: Chain): Promise<void> {
    const router = this.app.getContracts(chain).router;

    await Promise.all(
      this.app.remoteChains(chain).map(async (remoteChain) => {
        const remoteRouter = this.app.getContracts(remoteChain).router;
        const remoteChainId = chainMetadata[remoteChain].id;
        const actual = await router.routers(remoteChainId);
        const expected = utils.addressToBytes32(remoteRouter.address);
        if (actual !== expected) {
          const violation: EnrolledRouterViolation = {
            type: RouterViolationType.EnrolledRouter,
            contract: router,
            chain,
            actual,
            expected,
          };
          this.addViolation(violation);
        }
      }),
    );
  }

  ownables(chain: Chain): Ownable[] {
    return [this.app.getContracts(chain).router];
  }
}
