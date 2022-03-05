import { expect } from 'chai';

import { types } from '@abacus-network/utils';
// import { BeaconProxy } from '@abacus-network/abacus-deploy';
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
    // this.checkVerificationInputs(deploy);
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
    if (this.config.addresses[domain]) {
      expect(this.deploy.helper(domain)).to.not.be.undefined;
    } else {
      expect(this.deploy.helper(domain)).to.be.undefined;
    }
  }

  /*
  getVerificationInputs(deploy: BridgeDeploy): VerificationInput[] {
    const inputs: VerificationInput[] = [];
    const addInputsForUpgradableContract = (
      contract: BeaconProxy<any>,
      name: string,
    ) => {
      inputs.push([`${name} Implementation`, contract.implementation]);
      inputs.push([`${name} UpgradeBeacon`, contract.beacon]);
      inputs.push([`${name} Proxy`, contract.proxy]);
    };
    expect(deploy.contracts.bridgeToken).to.not.be.undefined;
    expect(deploy.contracts.bridgeRouter).to.not.be.undefined;
    addInputsForUpgradableContract(
      deploy.contracts.bridgeToken!,
      'BridgeToken',
    );
    addInputsForUpgradableContract(
      deploy.contracts.bridgeRouter!,
      'BridgeRouter',
    );
    if (deploy.chain.weth) {
      expect(deploy.contracts.ethHelper).to.not.be.undefined;
      inputs.push(['ETH Helper', deploy.contracts.ethHelper!]);
    }
    return inputs;
  }
  */
}
