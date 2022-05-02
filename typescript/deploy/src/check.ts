import { expect } from 'chai';

import { AbacusApp, ProxiedAddress } from '@abacus-network/sdk';
import { types } from '@abacus-network/utils';

import { CheckerViolation } from './config';
import { upgradeBeaconImplementation, upgradeBeaconViolation } from './proxy';

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
    if (!this.isDuplicateViolation(violation)) {
      this.violations.push(violation);
    }
  }

  async checkUpgradeBeacon(
    domain: types.Domain,
    name: string,
    proxiedAddress: ProxiedAddress,
  ) {
    const provider = await this.app.mustGetProvider(domain);
    const implementation = await upgradeBeaconImplementation(
      provider,
      proxiedAddress.beacon,
    );
    if (implementation !== proxiedAddress.implementation) {
      this.addViolation(
        upgradeBeaconViolation(domain, name, proxiedAddress, implementation),
      );
    }
  }

  isDuplicateViolation(violation: CheckerViolation) {
    const duplicates = this.violations.filter(
      (v) =>
        violation.type === v.type &&
        violation.domain === v.domain &&
        violation.actual === v.actual &&
        violation.expected === v.expected,
    );
    return duplicates.length > 0;
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
