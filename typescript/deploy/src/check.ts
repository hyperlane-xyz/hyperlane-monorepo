import { expect } from 'chai';
import { ethers } from 'ethers';
import { types } from '@abacus-network/utils';
import { AbacusApp, ProxiedAddress } from '@abacus-network/sdk';

export enum CommonViolationType {
  ProxiedContract = 'ProxiedContract',
}

export interface CheckerViolation {
  domain: number;
  type: string;
  expected: any;
  actual: any;
  data?: any;
}

export interface ProxiedContractViolation extends CheckerViolation {
  type: CommonViolationType.ProxiedContract;
  data: {
    proxiedAddress: ProxiedAddress;
    name: string;
  };
  actual: string;
  expected: string;
}

export abstract class AbacusAppChecker<A extends AbacusApp<any, any>, C> {
  readonly app: A;
  readonly config: C;
  readonly violations: CheckerViolation[];

  constructor(app: A, config: C) {
    this.app = app;
    this.config = config;
    this.violations = [];
  }

  addViolation(violation: CheckerViolation) {
    switch (violation.type) {
      case CommonViolationType.ProxiedContract:
        const proxiedContractViolations = this.violations.filter(
          (v) => v.type === CommonViolationType.ProxiedContract,
        );
        const matchingViolations = proxiedContractViolations.filter((v) => {
          return (
            violation.domain === v.domain &&
            violation.actual === v.actual &&
            violation.expected === v.expected
          );
        });
        if (matchingViolations.length === 0) this.violations.push(violation);
        break;
      default:
        this.violations.push(violation);
        break;
    }
  }

  async checkProxiedContract(
    domain: types.Domain,
    name: string,
    proxiedAddress: ProxiedAddress,
  ) {
    // TODO: This should check the correct upgrade beacon controller
    expect(proxiedAddress.beacon).to.not.be.undefined;
    expect(proxiedAddress.proxy).to.not.be.undefined;
    expect(proxiedAddress.implementation).to.not.be.undefined;

    const provider = this.app.mustGetProvider(domain);
    // Assert that the implementation is actually set
    const storageValue = await provider.getStorageAt(proxiedAddress.beacon, 0);
    const actual = ethers.utils.getAddress(storageValue.slice(26));
    const expected = proxiedAddress.implementation;

    if (actual != expected) {
      this.violations.push({
        domain,
        type: CommonViolationType.ProxiedContract,
        actual,
        expected,
        data: {
          name,
          proxiedAddress,
        },
      });
    }
  }

  expectViolations(types: string[], expectedMatches: number[]) {
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
