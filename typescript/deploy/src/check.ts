import { expect } from 'chai';

import {
  AbacusApp,
  ChainName,
  MultiProvider,
  ProxiedAddress,
} from '@abacus-network/sdk';
import { types } from '@abacus-network/utils';

import { CheckerViolation } from './config';
import { upgradeBeaconImplementation, upgradeBeaconViolation } from './proxy';

export interface Ownable {
  owner(): Promise<types.Address>;
}

export abstract class AbacusAppChecker<
  Networks extends ChainName,
  App extends AbacusApp<any, Networks>,
  Config,
> {
  readonly multiProvider: MultiProvider<Networks>;
  readonly app: App;
  readonly config: Config;
  readonly violations: CheckerViolation[];

  constructor(
    multiProvider: MultiProvider<Networks>,
    app: App,
    config: Config,
  ) {
    this.multiProvider = multiProvider;
    this.app = app;
    this.violations = [];
    this.config = config;
  }

  addViolation(violation: CheckerViolation) {
    if (!this.isDuplicateViolation(violation)) {
      this.violations.push(violation);
    }
  }

  async checkUpgradeBeacon(
    network: Networks,
    name: string,
    proxiedAddress: ProxiedAddress,
  ) {
    const dc = this.multiProvider.getDomainConnection(network);
    const implementation = await upgradeBeaconImplementation(
      dc.provider!,
      proxiedAddress.beacon,
    );
    if (implementation !== proxiedAddress.implementation) {
      this.addViolation(
        upgradeBeaconViolation(network, name, proxiedAddress, implementation),
      );
    }
  }

  async checkOwnership(
    owner: types.Address,
    ownables: Ownable[],
  ): Promise<void> {
    const owners = await Promise.all(ownables.map((o) => o.owner()));
    owners.map((_) => expect(_).to.equal(owner));
  }

  isDuplicateViolation(violation: CheckerViolation) {
    const duplicates = this.violations.filter(
      (v) =>
        violation.type === v.type &&
        violation.network === v.network &&
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
