import { ethers } from 'ethers';
import { expect } from 'chai';

import { types, utils } from '@abacus-network/utils';
// import { BeaconProxy } from '@abacus-network/abacus-deploy';
import { GovernanceConfig } from './types';
import { GovernanceDeploy } from './GovernanceDeploy';
// import { VerificationInput, InvariantChecker } from '../checks';
import { InvariantChecker } from '../checks';

export class GovernanceInvariantChecker extends InvariantChecker<GovernanceDeploy> {
  readonly config: GovernanceConfig;

  constructor(deploy: GovernanceDeploy, config: GovernanceConfig) {
    super(deploy);
    this.config = config;
  }

  async checkDomain(domain: types.Domain): Promise<void> {
    await this.checkBeaconProxies(domain);
    await this.checkGovernor(domain);
    await this.checkRecoveryManager(domain);
    await this.checkXAppConnectionManager(domain);
    await this.checkEnrolledRouters(domain);
    // await this.checkOwnership(domain);
    // this.checkVerificationInputs(domain);
  }

  async checkBeaconProxies(domain: types.Domain): Promise<void> {
    // TODO(asa): This should check UBC as well
    await this.checkBeaconProxyImplementation(
      domain,
      'GovernanceRouter',
      this.deploy.instances[domain].contracts.router,
    );
  }

  // TODO(asa): Dedupe
  async checkEnrolledRouters(domain: types.Domain): Promise<void> {
    const router = this.deploy.router(domain);
    await Promise.all(
      this.deploy.remotes(domain).map(async (remote) => {
        const remoteRouter = await this.deploy.router(remote);
        expect(await router.routers(remote)).to.equal(utils.addressToBytes32(remoteRouter.address));
      }),
    );
  }

  // TODO(asa): Dedupe
  async checkXAppConnectionManager(domain: types.Domain): Promise<void> {
    const actual = await this.deploy.router(domain).xAppConnectionManager()
    const expected = this.config.core[this.deploy.name(domain)].xAppConnectionManager;
    expect(actual).to.equal(expected);
  }

  async checkGovernor(domain: types.Domain): Promise<void> {
    const actual = await this.deploy.router(domain).governor()
    const expected = this.config.addresses[this.deploy.name(domain)].governor;
    if (expected) {
      expect(actual).to.equal(expected);
    } else {
      expect(actual).to.equal(ethers.constants.AddressZero);
    }
  }

  async checkRecoveryManager(domain: types.Domain): Promise<void> {
    const actual = await this.deploy.router(domain).recoveryManager()
    const expected = this.config.addresses[this.deploy.name(domain)].recoveryManager;
    expect(actual).to.equal(expected);
  }
}
