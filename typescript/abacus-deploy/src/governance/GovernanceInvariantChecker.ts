import { ethers } from 'ethers';
import { expect } from 'chai';

import { types } from '@abacus-network/utils';
// import { BeaconProxy } from '@abacus-network/abacus-deploy';
import { GovernanceConfig } from './types';
import { GovernanceDeploy } from './GovernanceDeploy';
// import { VerificationInput, InvariantChecker } from '../checks';
import { RouterInvariantChecker } from '../router';

export class GovernanceInvariantChecker extends RouterInvariantChecker<
  GovernanceDeploy,
  GovernanceConfig
> {
  async checkDomain(domain: types.Domain): Promise<void> {
    await this.checkBeaconProxies(domain);
    await this.checkGovernor(domain);
    await this.checkRecoveryManager(domain);
    await this.checkXAppConnectionManager(domain);
    await this.checkEnrolledRouters(domain);
    await this.checkOwnership(domain);
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

  async checkGovernor(domain: types.Domain): Promise<void> {
    const actual = await this.deploy.router(domain).governor();
    const expected = this.config.addresses[this.deploy.name(domain)].governor;
    if (expected) {
      expect(actual).to.equal(expected);
    } else {
      expect(actual).to.equal(ethers.constants.AddressZero);
    }
  }

  async checkRecoveryManager(domain: types.Domain): Promise<void> {
    const actual = await this.deploy.router(domain).recoveryManager();
    const expected =
      this.config.addresses[this.deploy.name(domain)].recoveryManager;
    expect(actual).to.equal(expected);
  }
}
