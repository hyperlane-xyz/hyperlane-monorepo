import { ethers } from 'ethers';

import { utils } from '@hyperlane-xyz/utils';

import { HyperlaneFactories } from '../contracts';
import { HyperlaneAppChecker } from '../deploy/HyperlaneAppChecker';
import { ChainName } from '../types';

import { RouterApp } from './RouterApps';
import {
  ConnectionClientViolation,
  ConnectionClientViolationType,
  RouterConfig,
} from './types';

export class HyperlaneRouterChecker<
  Factories extends HyperlaneFactories,
  App extends RouterApp<Factories>,
  Config extends RouterConfig,
> extends HyperlaneAppChecker<App, Config> {
  checkOwnership(chain: ChainName): Promise<void> {
    const owner = this.configMap[chain].owner;
    return super.checkOwnership(chain, owner);
  }

  async checkChain(chain: ChainName): Promise<void> {
    await this.checkHyperlaneConnectionClient(chain);
    await this.checkEnrolledRouters(chain);
    await this.checkOwnership(chain);
  }

  async checkHyperlaneConnectionClient(chain: ChainName): Promise<void> {
    const router = this.app.router(this.app.getContracts(chain));

    const checkConnectionClientProperty = async (
      property: keyof RouterConfig,
      violationType: ConnectionClientViolationType,
    ) => {
      const actual = await router[property]();
      const expected =
        this.configMap[chain][property] ?? ethers.constants.AddressZero;
      if (!utils.eqAddress(actual, expected)) {
        const violation: ConnectionClientViolation = {
          chain,
          type: violationType,
          contract: router,
          actual,
          expected,
        };
        this.addViolation(violation);
      }
    };

    await checkConnectionClientProperty(
      'mailbox',
      ConnectionClientViolationType.Mailbox,
    );
    await checkConnectionClientProperty(
      'interchainGasPaymaster',
      ConnectionClientViolationType.InterchainGasPaymaster,
    );
    await checkConnectionClientProperty(
      'interchainSecurityModule',
      ConnectionClientViolationType.InterchainSecurityModule,
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
        utils.assert(address === utils.addressToBytes32(remoteRouter.address));
      }),
    );
  }
}
