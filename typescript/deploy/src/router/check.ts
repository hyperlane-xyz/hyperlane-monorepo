import { expect } from 'chai';
import { utils, types } from '@abacus-network/utils';
import { AbacusApp } from '@abacus-network/sdk';
import { AbacusAppChecker } from '../check';

import { Router, RouterConfig } from './types';

export abstract class AbacusRouterChecker<
  A extends AbacusApp<any, any>,
  C extends RouterConfig,
> extends AbacusAppChecker<A, C> {
  abstract mustGetRouter(domain: types.Domain): Router;

  async check(
    owners: Partial<Record<types.Domain, types.Address>>,
  ): Promise<void> {
    await Promise.all(
      this.app.domainNumbers.map((domain: types.Domain) => {
        const owner = owners[domain];
        if (!owner) throw new Error('owner not found');
        return this.checkDomain(domain, owner);
      }),
    );
  }

  async checkDomain(domain: types.Domain, owner: types.Address): Promise<void> {
    await this.checkEnrolledRouters(domain);
    await this.checkOwnership(domain, owner);
    await this.checkAbacusConnectionManager(domain);
  }

  async checkEnrolledRouters(domain: types.Domain): Promise<void> {
    const router = this.mustGetRouter(domain);
    await Promise.all(
      this.app.remoteDomainNumbers(domain).map(async (remote) => {
        const remoteRouter = await this.mustGetRouter(remote);
        expect(await router.routers(remote)).to.equal(
          utils.addressToBytes32(remoteRouter.address),
        );
      }),
    );
  }

  async checkOwnership(
    domain: types.Domain,
    owner: types.Address,
  ): Promise<void> {
    const contracts = this.app.mustGetContracts(domain);
    const owners = await Promise.all([
      contracts.upgradeBeaconController.owner(),
      this.mustGetRouter(domain).owner(),
    ]);
    // If the config specifies that a abacusConnectionManager should have been deployed,
    // it should be owned by the owner.
    if (!this.config.abacusConnectionManager) {
      owners.push(contracts.abacusConnectionManager.owner());
    }
    (await Promise.all(owners)).map((_) => expect(_).to.equal(owner));
  }

  async checkAbacusConnectionManager(domain: types.Domain): Promise<void> {
    if (this.config.abacusConnectionManager === undefined) return;
    const actual = await this.mustGetRouter(domain).abacusConnectionManager();
    const expected =
      this.config.abacusConnectionManager[
        this.app.mustResolveDomainName(domain)
      ];
    expect(actual).to.equal(expected);
  }
}
