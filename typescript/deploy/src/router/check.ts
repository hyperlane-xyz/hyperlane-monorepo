import { expect } from 'chai';
import { utils, types } from '@abacus-network/utils';
import { AbacusApp } from '@abacus-network/sdk';

import { AbacusAppChecker, Ownable } from '../check';
import { RouterConfig, Router } from './types';

export abstract class AbacusRouterChecker<
  A extends AbacusApp<any, any>,
  C extends RouterConfig,
> extends AbacusAppChecker<A, C> {
  abstract mustGetRouter(domain: types.Domain): Router;

  async check(
    owners: Partial<Record<types.Domain, types.Address>> | types.Address,
  ): Promise<void> {
    await Promise.all(
      this.app.domainNumbers.map((domain: types.Domain) => {
        let owner: types.Address;
        if (typeof owners === 'string') {
          owner = owners;
        } else {
          owner = owners[domain]!;
          if (!owner) throw new Error('owner not found');
        }
        return this.checkDomain(domain, owner);
      }),
    );
  }

  async checkDomain(domain: types.Domain, owner: types.Address): Promise<void> {
    await this.checkEnrolledRouters(domain);
    await this.checkOwnership(domain, owner, this.ownables(domain));
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

  ownables(domain: types.Domain): Ownable[] {
    const ownables: Ownable[] = [this.mustGetRouter(domain)];
    // If the config specifies that a xAppConnectionManager should have been deployed,
    // it should be owned by the owner.
    if (!this.config.xAppConnectionManager) {
      const contracts = this.app.mustGetContracts(domain);
      ownables.push(contracts.xAppConectionManager);
    }
    return ownables;
  }

  async checkXAppConnectionManager(domain: types.Domain): Promise<void> {
    if (this.config.xAppConnectionManager === undefined) return;
    const actual = await this.mustGetRouter(domain).xAppConnectionManager();
    const expected =
      this.config.xAppConnectionManager[this.app.mustResolveDomainName(domain)];
    expect(actual).to.equal(expected);
  }
}
