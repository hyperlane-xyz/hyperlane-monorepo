import { expect } from 'chai';
import { Contract, ethers } from 'ethers';
import { Deploy } from './deploy';
import { ProxyNames, BeaconProxy } from './proxyUtils';

export enum ViolationType {
  UpgradeBeacon = 'UpgradeBeacon',
  VerificationInput = 'VerificationInput',
  UpdaterManager = 'UpdaterManager',
  HomeUpdater = 'HomeUpdater',
  ReplicaUpdater = 'ReplicaUpdater',
}

export interface UpgradeBeaconViolation {
  domain: number
  name: ProxyNames
  type: ViolationType.UpgradeBeacon,
  beaconProxy: BeaconProxy<ethers.Contract>,
  expected: string
  actual: string
}

interface VerificationInputViolation {
  domain: number
  type: ViolationType.VerificationInput,
  name: string
  address: string
}

export interface UpdaterManagerViolation {
  domain: number
  type: ViolationType.UpdaterManager,
  expected: string
  actual: string
}

export interface HomeUpdaterViolation {
  domain: number
  type: ViolationType.HomeUpdater,
  expected: string
  actual: string
}

export interface ReplicaUpdaterViolation {
  domain: number
  remoteDomain: number
  type: ViolationType.ReplicaUpdater,
  expected: string
  actual: string
}

export type Violation = UpgradeBeaconViolation | VerificationInputViolation | HomeUpdaterViolation | ReplicaUpdaterViolation | UpdaterManagerViolation

export type VerificationInput = [string, Contract];

export abstract class InvariantChecker<T extends Deploy<any>> { 
  readonly _deploys: T[]
  readonly violations: Violation[];

  abstract checkDeploy(deploy: T): Promise<void>;
  abstract getVerificationInputs(deploy: T): VerificationInput[]

  constructor(deploys: T[]) {
    this._deploys = deploys;
    this.violations = [];
  }

  async checkDeploys(): Promise<void> {
    await Promise.all(this._deploys.map(this.checkDeploy))
  }

  addViolation(v: Violation) {
    switch (v.type) {
      case ViolationType.UpgradeBeacon:
        const duplicateIndex = this.violations.findIndex((m: Violation) =>
          m.type === ViolationType.UpgradeBeacon &&
          m.domain === v.domain &&
          m.actual === v.actual &&
          m.expected === v.expected
        )
        if (duplicateIndex === -1) this.violations.push(v);
        break;
      default:
        this.violations.push(v);
        break;
    }
  }

  async checkBeaconProxyImplementation(
    domain: number,
    name: ProxyNames,
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
    const actual = ethers.utils.getAddress(storageValue.slice(26));
    const expected = beaconProxy.implementation.address;

    if (actual != expected) {
      const violation: UpgradeBeaconViolation = {
        domain,
        type: ViolationType.UpgradeBeacon,
        name,
        beaconProxy,
        actual,
        expected
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
    inputs.map((input) => this.checkVerificationInput(deploy, input[0], input[1].address))
  }

  expectEmpty(): void {
    expect(this.violations).to.be.empty;
  }
}
