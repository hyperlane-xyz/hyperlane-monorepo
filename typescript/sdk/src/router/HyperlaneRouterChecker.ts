import { ethers } from 'ethers';

import { addressToBytes32, assert, eqAddress } from '@hyperlane-xyz/utils';

import { HyperlaneFactories } from '../contracts/types';
import { HyperlaneAppChecker } from '../deploy/HyperlaneAppChecker';
import { ChainName } from '../types';

import { RouterApp } from './RouterApps';
import {
  ClientViolation,
  ClientViolationType,
  MailboxClientConfig,
  OwnableConfig,
  RouterConfig,
} from './types';

export class HyperlaneRouterChecker<
  Factories extends HyperlaneFactories,
  App extends RouterApp<Factories>,
  Config extends RouterConfig,
> extends HyperlaneAppChecker<App, Config> {
  async checkChain(chain: ChainName): Promise<void> {
    await this.checkMailboxClient(chain);
    await this.checkEnrolledRouters(chain);
    await super.checkOwnership(chain, this.configMap[chain].owner);
  }

  async checkMailboxClient(chain: ChainName): Promise<void> {
    const router = this.app.router(this.app.getContracts(chain));

    const checkConnectionClientProperty = async (
      property: keyof (MailboxClientConfig & OwnableConfig),
      violationType: ClientViolationType,
    ) => {
      const actual = await router[property]();
      // TODO: check for IsmConfig
      const value = this.configMap[chain][property];
      if (value && typeof value === 'object')
        throw new Error('object config unimplemented');
      const expected =
        value && typeof value === 'string'
          ? value
          : ethers.constants.AddressZero;
      if (!eqAddress(actual, expected)) {
        const violation: ClientViolation = {
          chain,
          type: violationType,
          contract: router,
          actual,
          expected,
        };
        this.addViolation(violation);
      }
    };

    await checkConnectionClientProperty('mailbox', ClientViolationType.Mailbox);
    await checkConnectionClientProperty('hook', ClientViolationType.Hook);
    await checkConnectionClientProperty(
      'interchainSecurityModule',
      ClientViolationType.Hook,
    );
  }

  async checkEnrolledRouters(chain: ChainName): Promise<void> {
    const router = this.app.router(this.app.getContracts(chain));

    await Promise.all(
      this.app.remoteChains(chain).map(async (remoteChain) => {
        const remoteRouter = this.app.router(
          this.app.getContracts(remoteChain),
        );
        const remoteDomainId = this.multiProvider.getDomainId(remoteChain);
        const address = await router.routers(remoteDomainId);
        assert(address === addressToBytes32(remoteRouter.address));
      }),
    );
  }
}
