import { Ownable } from '@hyperlane-xyz/core';
import { utils } from '@hyperlane-xyz/utils';

import { HyperlaneApp } from '../../HyperlaneApp';
import { chainMetadata } from '../../consts/chainMetadata';
import { RouterContracts } from '../../router';
import { ChainName } from '../../types';
import { HyperlaneAppChecker } from '../HyperlaneAppChecker';

import { RouterConfig } from './types';

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
      this.app.remoteChains(chain).map(async (remoteNetwork) => {
        const remoteRouter = this.app.getContracts(remoteNetwork).router;
        const remoteChainId = chainMetadata[remoteNetwork].id;
        const address = await router.routers(remoteChainId);
        utils.assert(address === utils.addressToBytes32(remoteRouter.address));
      }),
    );
  }

  ownables(chain: Chain): Ownable[] {
    return [this.app.getContracts(chain).router];
  }
}
