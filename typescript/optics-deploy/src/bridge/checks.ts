import { expect } from 'chai';

import { BridgeDeploy } from './BridgeDeploy';
import TestBridgeDeploy from './TestBridgeDeploy';
import { assertBeaconProxy, checkVerificationInput } from '../checks';

const emptyAddr = '0x' + '00'.repeat(32);

type AnyBridgeDeploy = BridgeDeploy | TestBridgeDeploy;


export class BridgeInvariantChecker extends InvariantChecker<AnyBridgeDeploy> {
  async checkDeploy(deploy: AnyBridgeDeploy): Promise<void> {
    await this.checkBeaconProxies(deploy)
    await this.checkBridgeRouter(deploy)
    this.checkEthHelper(deploy)
    this.checkVerificationInputs(deploy)
  }

  async checkBeaconProxies(deploy: AnyBridgeDeploy): Promise<void> {
    await this.checkBeaconProxyImplementation(
      deploy.chain.domain,
      'BridgeToken',
      undefined,
      deploy.contracts.bridgeToken!,
    );
    await this.checkBeaconProxyImplementation(
      deploy.chain.domain,
      'BridgeRouter',
      undefined,
      deploy.contracts.bridgeRouter!,
    );
  }

  async checkBridgeRouter(deploy: AnyBridgeDeploy): Promise<void> {
    const bridgeRouter = deploy.contracts.bridgeRouter?.proxy!;
    const domains = this._deploys.map((d: AnyBridgeDeploy) => d.chain.domain)
    const remoteDomains = domains.filter((d: number) => d !== deploy.chain.domain)
    await Promise.all(
      remoteDomains.map(async (remoteDomain) => {
        const registeredRouter = await bridgeRouter.remotes(remoteDomain);
        expect(registeredRouter).to.not.equal(emptyAddr);
      }),
    );

    expect(await bridgeRouter.owner()).to.equal(
      deploy.coreContractAddresses.governance.proxy,
    );
  }

  checkEthHelper(deploy: AnyBridgeDeploy): void {
    if (deploy.config.weth) {
      expect(deploy.contracts.ethHelper).to.not.be.undefined;
    } else {
      expect(deploy.contracts.ethHelper).to.be.undefined;
    }
  }

  getVerificationInputs(deploy: CoreDeploy): VerificationInput[] {
    const inputs: VerificationInput[] = []
    const addInputsForUpgradableContract = (contract: BeaconProxy<any>, name: string) => {
      inputs.push([`${name} Implementation`, contract.implementation.address])
      inputs.push([`${name} UpgradeBeacon`, contract.beacon.address])
      inputs.push([`${name} Proxy`, contract.proxy.address])
    }
    addInputsForUpgradableContract(deploy.contracts.bridgeToken, 'BridgeToken')
    addInputsForUpgradableContract(deploy.contracts.bridgeRouter, 'BridgeRouter')
    if (deploy.config.weth) {
      inputs.push(['EthHelper', deploy.contracts.ethHelper.address])
    }
    return inputs
  }
}
