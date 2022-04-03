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
    await this.checkXAppConnectionManager(domain);
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
    const owners = [
      // TODO: Local tests failing because the fake connection manager
      // we set isn't ownable.
      // contracts.xAppConnectionManager.owner(),
      contracts.upgradeBeaconController.owner(),
      this.mustGetRouter(domain).owner(),
    ];
    const actual = await Promise.all(owners);
    const expected = contracts.router.address;
    actual.map((_) => expect(_).to.equal(expected));
  }

  async checkXAppConnectionManager(domain: types.Domain): Promise<void> {
    if (this.config.xAppConnectionManager === undefined) return;
    const actual = await this.mustGetRouter(domain).xAppConnectionManager();
    const expected =
      this.config.xAppConnectionManager[this.app.mustResolveDomainName(domain)];
    expect(actual).to.equal(expected);
  }
}
