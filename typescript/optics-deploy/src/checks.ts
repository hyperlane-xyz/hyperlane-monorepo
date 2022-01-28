import { expect } from 'chai';
import { Contract, ethers } from 'ethers';
import { Deploy } from './deploy';
import { ProxyNames, BeaconProxy } from './proxyUtils';
import { UpgradeBeaconController } from '@optics-xyz/ts-interface/dist/optics-core';

export enum ViolationType {
  UpgradeBeacon,
  VerificationInput,
}

interface UpgradeBeaconViolation {
  domain: number
  name: ProxyNames
  upgradeBeaconController: UpgradeBeaconController,
  type: ViolationType.UpgradeBeacon,
  beaconProxy: BeaconProxy<ethers.Contract>,
  expectedImplementationAddress: string
  actualImplementationAddress: string
}

interface VerificationInputViolation {
  domain: number
  type: ViolationType.VerificationInput,
  name: string
  address: string
}

export type Violation = UpgradeBeaconViolation | VerificationInputViolation

type VerificationInput = [string, Contract]

export abstract class InvariantChecker<T extends Deploy<any>> { 
  private _deploys: T[]
  readonly violations: Violation[];

  abstract checkDeploy(deploy: T): void;
  abstract getVerificationInputs(deploy: T): VerificationInput[]

  constructor(deploys: T[]) {
    this._deploys = deploys;
    this.violations = [];
  }

  checkDeploys(): void {
    for (const deploy of this._deploys) {
      this.checkDeploy(deploy)
    }
  }

  addViolation(v: Violation) {
    switch (v.type) {
      case ViolationType.UpgradeBeacon:
        const duplicateIndex = this.violations.findIndex((m: Violation) =>
          m.domain === v.domain &&
          m.actualImplementationAddress === v.actualImplementationAddress &&
          m.expectedImplementationAddress === v.expectedImplementationAddress
        )
        if (duplicateIndex === -1) this.violations.push(v);
        break;
      case ViolationType.VerificationInput:
        this.violations.push(v);
        break;
      default:
        break;
    }
  }

  async checkBeaconProxyImplementation(
    domain: number,
    name: ProxyNames,
    upgradeBeaconController: UpgradeBeaconController,
    beaconProxy: BeaconProxy<Contract>,
  ) {
    expect(beaconProxy.beacon).to.not.be.undefined;
    expect(beaconProxy.proxy).to.not.be.undefined;
    expect(beaconProxy.implementation).to.not.be.undefined;

    // Assert that the implementation is actually set
    const provider = beaconProxy.beacon.provider;
    const storageValue = await provider.getStorageAt(
      beaconProxy.beacon.address,
      0,
    );
    const actualImplementationAddress = ethers.utils.getAddress(
      storageValue.slice(26),
    );

    if (actualImplementationAddress != beaconProxy.implementation.address) {
      const violation: UpgradeBeaconViolation = {
        domain, 
        type: ViolationType.UpgradeBeacon,
        name,
        upgradeBeaconController,
        beaconProxy,
        actualImplementationAddress,
        expectedImplementationAddress: beaconProxy.implementation.address,
      }
      this.addViolation(violation)
    }
  }

  checkVerificationInput(deploy: T, name: string, address: string) {
    const match = deploy.verificationInput.find(
      (contract) => contract.name == name && contract.address === address
    )
    if (match === undefined) {
      const violation: VerificationInputViolation = {
        domain: deploy.chain.domain,
        type: ViolationType.VerificationInput,
        name,
        address
      }
      this.addViolation(violation)
    }
  }

  checkVerificationInputs(deploy: T) {
    const inputs = this.getVerificationInputs(deploy)
    const check = (input: VerificationInput) => {
      this.checkVerificationInput(deploy, input[0], input[1])
    }
    inputs.map(check)
  }

  expectEmpty(): void {
    expect(this.violations).to.be.empty;
  }
}
