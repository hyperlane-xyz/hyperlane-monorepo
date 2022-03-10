import { expect } from 'chai';
import { utils, types } from '@abacus-network/utils';
import { CommonInvariantChecker } from '../common';
import { RouterInstance } from './RouterInstance';
import { RouterDeploy } from './RouterDeploy';
import { RouterConfig } from './types';

export abstract class RouterInvariantChecker<
  T extends RouterDeploy<RouterInstance<any>, any>,
  V extends RouterConfig,
> extends CommonInvariantChecker<T, V> {
  async checkEnrolledRouters(domain: types.Domain): Promise<void> {
    const router = this.deploy.router(domain);
    await Promise.all(
      this.deploy.remotes(domain).map(async (remote) => {
        const remoteRouter = await this.deploy.router(remote);
        expect(await router.routers(remote)).to.equal(
          utils.addressToBytes32(remoteRouter.address),
        );
      }),
    );
  }

  async checkOwnership(domain: types.Domain): Promise<void> {
    const actual = await this.deploy.router(domain).owner();
    const expected = this.owners[domain];
    expect(actual).to.equal(expected);
  }

  async checkXAppConnectionManager(domain: types.Domain): Promise<void> {
    const actual = await this.deploy.router(domain).xAppConnectionManager();
    const core = this.config.core[this.deploy.name(domain)];
    if (core === undefined) throw new Error('could not find core');
    const expected = core.xAppConnectionManager;
    expect(actual).to.equal(expected);
  }
}
