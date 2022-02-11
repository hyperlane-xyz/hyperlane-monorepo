import { expect } from 'chai';

import { BridgeDeploy } from './BridgeDeploy';
import { VerificationInput, InvariantChecker } from '../checks';
import { BeaconProxy } from '../utils/proxy';

const emptyAddr = '0x' + '00'.repeat(32);

export class BridgeInvariantChecker extends InvariantChecker<BridgeDeploy> {
  constructor(deploys: BridgeDeploy[]) {
    super(deploys);
  }

  async checkDeploy(deploy: BridgeDeploy): Promise<void> {
    await this.checkBeaconProxies(deploy);
    await this.checkBridgeRouter(deploy);
    this.checkEthHelper(deploy);
    this.checkVerificationInputs(deploy);
  }

  async checkBeaconProxies(deploy: BridgeDeploy): Promise<void> {
    await this.checkBeaconProxyImplementation(
      deploy.chain.domain,
      'BridgeToken',
      deploy.contracts.bridgeToken!,
    );
    await this.checkBeaconProxyImplementation(
      deploy.chain.domain,
      'BridgeRouter',
      deploy.contracts.bridgeRouter!,
    );
  }

  async checkBridgeRouter(deploy: BridgeDeploy): Promise<void> {
    const bridgeRouter = deploy.contracts.bridgeRouter?.proxy!;
    const domains = this._deploys.map((d: BridgeDeploy) => d.chain.domain);
    const remoteDomains = domains.filter(
      (d: number) => d !== deploy.chain.domain,
    );
    await Promise.all(
      remoteDomains.map(async (remoteDomain) => {
        const registeredRouter = await bridgeRouter.remotes(remoteDomain);
        expect(registeredRouter).to.not.equal(emptyAddr);
      }),
    );

    expect(await bridgeRouter.owner()).to.equal(
      deploy.coreContractAddresses.governanceRouter.proxy,
    );
  }

  checkEthHelper(deploy: BridgeDeploy): void {
    if (deploy.chain.weth) {
      expect(deploy.contracts.ethHelper).to.not.be.undefined;
    } else {
      expect(deploy.contracts.ethHelper).to.be.undefined;
    }
  }

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
}
