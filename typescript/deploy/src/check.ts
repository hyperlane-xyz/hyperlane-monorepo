import { expect } from 'chai';

import {
  AbacusApp,
  ChainMap,
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
  Chain extends ChainName,
  App extends AbacusApp<any, Chain>,
  Config,
> {
  readonly multiProvider: MultiProvider<Chain>;
  readonly app: App;
  readonly configMap: ChainMap<Chain, Config>;
  readonly violations: CheckerViolation[];

  constructor(
    multiProvider: MultiProvider<Chain>,
    app: App,
    configMap: ChainMap<Chain, Config>,
  ) {
    this.multiProvider = multiProvider;
    this.app = app;
    this.violations = [];
    this.configMap = configMap;
  }

  abstract checkChain(chain: Chain): Promise<void>;

  async check() {
    return Promise.all(
      this.app.chains().map((chain) => this.checkChain(chain)),
    );
  }

  addViolation(violation: CheckerViolation) {
    if (!this.isDuplicateViolation(violation)) {
      this.violations.push(violation);
    }
  }

  async checkUpgradeBeacon(
    chain: Chain,
    name: string,
    proxiedAddress: ProxiedAddress,
  ) {
    const provider = this.multiProvider.getProvider(chain);
    const implementation = await upgradeBeaconImplementation(
      provider,
      proxiedAddress.beacon,
    );
    if (implementation !== proxiedAddress.implementation) {
      this.addViolation(
        upgradeBeaconViolation(chain, name, proxiedAddress, implementation),
      );
    }
  }

  static async checkOwnership(
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
        violation.chain === v.chain &&
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
