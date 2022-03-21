import { expect } from 'chai';
import { utils, types } from '@abacus-network/utils';
import { AbacusApp } from '@abacus-network/sdk';
import { CommonInvariantChecker } from '../common';
import { Router, RouterConfig } from './types';

export abstract class RouterInvariantChecker<A extends AbacusApp<any, any>, C extends RouterConfig> extends CommonInvariantChecker<A, C> {
  abstract mustGetRouter(domain: types.Domain): Router;

  async checkDomain(domain: types.Domain): Promise<void> {
    await this.checkEnrolledRouters(domain);
    await this.checkOwnership(domain);
    await this.checkXAppConnectionManager(domain)
  }

  async checkEnrolledRouters(domain: types.Domain): Promise<void> {
    const router = this.mustGetRouter(domain)
    await Promise.all(
      this.app.remoteDomainNumbers(domain).map(async (remote) => {
        const remoteRouter = await this.mustGetRouter(remote)
        expect(await router.routers(remote)).to.equal(
          utils.addressToBytes32(remoteRouter.address),
        );
      }),
    );
  }

  async checkOwnership(domain: types.Domain): Promise<void> {
    const actual = await this.mustGetRouter(domain).owner();
    const expected = this.owners[domain];
    expect(actual).to.equal(expected);
  }

  async checkXAppConnectionManager(domain: types.Domain): Promise<void> {
    const actual = await this.mustGetRouter(domain).xAppConnectionManager();
    const core = this.config.core[this.app.mustResolveDomainName(domain)]
    if (!core) throw new Error('could not find core');
    const expected = core.xAppConnectionManager;
    expect(actual).to.equal(expected);
  }
}
