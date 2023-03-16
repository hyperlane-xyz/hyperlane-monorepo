import { ethers } from 'ethers';

import { Ownable } from '@hyperlane-xyz/core';
import { utils } from '@hyperlane-xyz/utils';

import { HyperlaneApp } from '../HyperlaneApp';
import { HyperlaneAppChecker } from '../deploy/HyperlaneAppChecker';
import { RouterContracts } from '../router/types';
import { ChainName } from '../types';

import { RouterConfig } from './types';

export class HyperlaneRouterChecker<
  App extends HyperlaneApp<Contracts>,
  Config extends RouterConfig,
  Contracts extends RouterContracts,
> extends HyperlaneAppChecker<App, Config> {
  checkOwnership(chain: ChainName): Promise<void> {
    const owner = this.configMap[chain].owner;
    const ownables = this.ownables(chain);
    return super.checkOwnership(chain, owner, ownables);
  }

  async checkChain(chain: ChainName): Promise<void> {
    await this.checkHyperlaneConnectionClient(chain);
    await this.checkEnrolledRouters(chain);
    await this.checkOwnership(chain);
  }

  async checkHyperlaneConnectionClient(chain: ChainName): Promise<void> {
    const router = this.app.getContracts(chain).router;
    const mailbox = await router.mailbox();
    const igp = await router.interchainGasPaymaster();
    const ism = await router.interchainSecurityModule();
    utils.assert(
      utils.eqAddress(mailbox, this.configMap[chain].mailbox),
      'Mailbox mismatch',
    );
    utils.assert(
      utils.eqAddress(igp, this.configMap[chain].interchainGasPaymaster),
      'IGP mismatch',
    );
    utils.assert(
      this.configMap[chain].interchainSecurityModule
        ? utils.eqAddress(ism, this.configMap[chain].interchainSecurityModule!)
        : utils.eqAddress(ism, ethers.constants.AddressZero),
    );
  }

  async checkEnrolledRouters(chain: ChainName): Promise<void> {
    const router = this.app.getContracts(chain).router;

    await Promise.all(
      this.app.remoteChains(chain).map(async (remoteChain) => {
        const remoteRouter = this.app.getContracts(remoteChain).router;
        const remoteDomainId = this.multiProvider.getDomainId(remoteChain);
        const address = await router.routers(remoteDomainId);
        utils.assert(address === utils.addressToBytes32(remoteRouter.address));
      }),
    );
  }

  ownables(chain: ChainName): Ownable[] {
    return [this.app.getContracts(chain).router];
  }
}
