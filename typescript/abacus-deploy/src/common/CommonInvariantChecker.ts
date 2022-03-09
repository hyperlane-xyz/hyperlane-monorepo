import { expect } from 'chai';
import { Contract, ethers } from 'ethers';
import { types } from '@abacus-network/utils';
import { BeaconProxy } from './BeaconProxy';
import { CommonDeploy } from './CommonDeploy';
import { CommonInstance } from './CommonInstance';
import { BeaconProxyPrefix } from '../verification';

export enum ViolationType {
  UpgradeBeacon = 'UpgradeBeacon',
  ValidatorManager = 'ValidatorManager',
  Validator = 'Validator',
}

export interface UpgradeBeaconViolation {
  domain: number;
  name: BeaconProxyPrefix;
  type: ViolationType.UpgradeBeacon;
  beaconProxy: BeaconProxy<ethers.Contract>;
  expected: string;
  actual: string;
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
  | ValidatorViolation
  | ValidatorManagerViolation;

export type VerificationInput = [string, Contract];

export abstract class CommonInvariantChecker<
  T extends CommonDeploy<CommonInstance<any>, any>,
  V,
> {
  readonly deploy: T;
  readonly config: V;
  readonly owners: Record<types.Domain, types.Address>;
  readonly violations: Violation[];

  abstract checkDomain(domain: types.Domain): Promise<void>;
  abstract checkOwnership(domain: types.Domain): Promise<void>;

  constructor(
    deploy: T,
    config: V,
    owners: Record<types.Domain, types.Address>,
  ) {
    this.deploy = deploy;
    this.config = config;
    this.owners = owners;
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
    name: BeaconProxyPrefix,
    beaconProxy: BeaconProxy<Contract>,
  ) {
    // TODO: This should check the correct upgrade beacon controller
    expect(beaconProxy.beacon).to.not.be.undefined;
    expect(beaconProxy.proxy).to.not.be.undefined;
    expect(beaconProxy.contract).to.not.be.undefined;
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
