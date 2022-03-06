import { expect } from 'chai';

import { types } from '@abacus-network/utils';
import { BridgeConfig } from './types';
import { BridgeDeploy } from './BridgeDeploy';
// import { VerificationInput, InvariantChecker } from '../checks';
import { RouterInvariantChecker } from '../router';

export class BridgeInvariantChecker extends RouterInvariantChecker<
  BridgeDeploy,
  BridgeConfig
> {
  async checkDomain(domain: types.Domain): Promise<void> {
    await this.checkBeaconProxies(domain);
    await this.checkEnrolledRouters(domain);
    await this.checkOwnership(domain);
    this.checkEthHelper(domain);
  }

  async checkBeaconProxies(domain: types.Domain): Promise<void> {
    await this.checkBeaconProxyImplementation(
      domain,
      'BridgeToken',
      this.deploy.instances[domain].contracts.token,
    );
    await this.checkBeaconProxyImplementation(
      domain,
      'BridgeRouter',
      this.deploy.instances[domain].contracts.router,
    );
  }

  checkEthHelper(domain: types.Domain): void {
    if (this.config.weth[this.deploy.name(domain)]) {
      expect(this.deploy.helper(domain)).to.not.be.undefined;
    } else {
      expect(this.deploy.helper(domain)).to.be.undefined;
    }
  }
}
