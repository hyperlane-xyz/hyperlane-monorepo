import { expect } from 'chai';
import { Contract, ethers } from 'ethers';
import { types } from '@abacus-network/utils';
import { BeaconProxy, Deploy } from '@abacus-network/abacus-deploy';

type ProxyNames =
  | 'Outbox'
  | 'Inbox'
  | 'GovernanceRouter'
  | 'BridgeToken'
  | 'BridgeRouter';

export enum ViolationType {
  UpgradeBeacon = 'UpgradeBeacon',
  VerificationInput = 'VerificationInput',
  ValidatorManager = 'ValidatorManager',
  Validator = 'Validator',
}

export interface UpgradeBeaconViolation {
  domain: number;
  name: ProxyNames;
  type: ViolationType.UpgradeBeacon;
  beaconProxy: BeaconProxy<ethers.Contract>;
  expected: string;
  actual: string;
}

interface VerificationInputViolation {
  domain: number;
  type: ViolationType.VerificationInput;
  name: string;
  address: string;
}

export interface ValidatorManagerViolation {
  domain: number;
  type: ViolationType.ValidatorManager;
  expected: string;
  actual: string;
}

export interface ValidatorViolation {
  local: number;
  remote: number;
  type: ViolationType.Validator;
  expected: string;
  actual: string;
}

export type Violation =
  | UpgradeBeaconViolation
  | VerificationInputViolation
  | ValidatorViolation
  | ValidatorManagerViolation;

export type VerificationInput = [string, Contract];

export abstract class InvariantChecker<T extends Deploy<any, any>> {
  readonly deploy: T;
  readonly violations: Violation[];

  abstract checkDomain(domain: types.Domain): Promise<void>;
  // abstract getVerificationInputs(domain: types.Domain): VerificationInput[];

  constructor(deploy: T) {
    this.deploy = deploy;
    this.violations = [];
  }

  async check(): Promise<void> {
    await Promise.all(
      this.deploy.domains.map((domain: types.Domain) =>
        this.checkDomain(domain),
      ),
    );
  }

  addViolation(v: Violation) {
    switch (v.type) {
      case ViolationType.UpgradeBeacon:
        const duplicateIndex = this.violations.findIndex(
          (m: Violation) =>
            m.type === ViolationType.UpgradeBeacon &&
            m.domain === v.domain &&
            m.actual === v.actual &&
            m.expected === v.expected,
        );
        if (duplicateIndex === -1) this.violations.push(v);
        break;
      default:
        this.violations.push(v);
        break;
    }
  }

  async checkBeaconProxyImplementation(
    domain: types.Domain,
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
        expected,
      };
      this.addViolation(violation);
    }
  }

  /*
  checkVerificationInput(domain: types.Domain, name: string, address: string) {
    const match = deploy.verificationInput.find(
      (contract) => contract.name == name && contract.address === address,
    );
    if (match === undefined) {
      const violation: VerificationInputViolation = {
        domain: deploy.chain.domain,
        type: ViolationType.VerificationInput,
        name,
        address,
      };
      this.addViolation(violation);
    }
  }

  checkVerificationInputs(domain: types.Domain) {
    const inputs = this.getVerificationInputs(domain);
    inputs.map((input) =>
      this.checkVerificationInput(deploy, input[0], input[1].address),
    );
  }
  */

  expectViolations(types: ViolationType[], expectedMatches: number[]) {
    // Every type should have exactly the number of expected matches.
    const actualMatches = types.map(
      (t) => this.violations.map((v) => v.type === t).filter(Boolean).length,
    );
    expect(actualMatches).to.deep.equal(expectedMatches);
    // Every violation should be matched by at least one partial.
    const unmatched = this.violations.map(
      (v) => types.map((t) => v.type === t).filter(Boolean).length,
    );
    expect(unmatched).to.not.include(0);
  }

  expectEmpty(): void {
    expect(this.violations).to.be.empty;
  }
}
