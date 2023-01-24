import { ethers } from 'ethers';

import { Ownable } from '@hyperlane-xyz/core';
import { utils } from '@hyperlane-xyz/utils';

import { HyperlaneApp } from '../../HyperlaneApp';
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
    await this.checkHyperlaneConnectionClient(chain);
    await this.checkEnrolledRouters(chain);
    await this.checkOwnership(chain);
  }

  async checkHyperlaneConnectionClient(chain: Chain): Promise<void> {
    const router = this.app.getContracts(chain).router;
    const mailbox = await router.mailbox();
    const igp = await router.interchainGasPaymaster();
    const ism = await router.interchainSecurityModule();
    utils.assert(mailbox, this.configMap[chain].mailbox);
    utils.assert(igp, this.configMap[chain].interchainGasPaymaster);
    utils.assert(
      ism,
      this.configMap[chain].interchainSecurityModule ||
        ethers.constants.AddressZero,
    );
  }

  async checkEnrolledRouters(chain: Chain): Promise<void> {
    const router = this.app.getContracts(chain).router;

    await Promise.all(
      this.app.remoteChains(chain).map(async (remoteChain) => {
        const remoteRouter = this.app.getContracts(remoteChain).router;
        const remoteChainId = (await router.provider.getNetwork()).chainId;
        const address = await router.routers(remoteChainId);
        utils.assert(address === utils.addressToBytes32(remoteRouter.address));
      }),
    );
  }

  ownables(chain: Chain): Ownable[] {
    return [this.app.getContracts(chain).router];
  }
}
