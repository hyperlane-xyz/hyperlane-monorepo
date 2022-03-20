import { ethers } from 'ethers';
import { expect } from 'chai';
import { types } from '@abacus-network/utils';

import { GovernanceConfig } from './types';
import { GovernanceDeploy } from './GovernanceDeploy';
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
  }

  async checkBeaconProxies(domain: types.Domain): Promise<void> {
    await this.checkBeaconProxyImplementation(
      domain,
      'GovernanceRouter',
      this.deploy.instances[domain].contracts.router,
    );
  }

  async checkGovernor(domain: types.Domain): Promise<void> {
    const actual = await this.deploy.router(domain).governor();
    const addresses = this.config.addresses[this.deploy.name(domain)];
    if (addresses === undefined) throw new Error('could not find addresses');
    if (addresses.governor) {
      expect(actual).to.equal(addresses.governor);
    } else {
      expect(actual).to.equal(ethers.constants.AddressZero);
    }
  }

  async checkRecoveryManager(domain: types.Domain): Promise<void> {
    const actual = await this.deploy.router(domain).recoveryManager();
    const addresses = this.config.addresses[this.deploy.name(domain)];
    if (addresses === undefined) throw new Error('could not find addresses');
    expect(actual).to.equal(addresses.recoveryManager);
  }
}
