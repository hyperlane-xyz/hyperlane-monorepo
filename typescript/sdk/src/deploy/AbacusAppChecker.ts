import { Ownable } from '@hyperlane-xyz/core';
import { utils } from '@hyperlane-xyz/utils';
import type { types } from '@hyperlane-xyz/utils';

import { AbacusApp } from '../AbacusApp';
import { MultiProvider } from '../providers/MultiProvider';
import { BeaconProxyAddresses } from '../proxy';
import { ChainMap, ChainName } from '../types';

import { upgradeBeaconImplementation, upgradeBeaconViolation } from './proxy';
import { CheckerViolation, OwnerViolation, ViolationType } from './types';

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

  async check(): Promise<void[]> {
    return Promise.all(
      this.app.chains().map((chain) => this.checkChain(chain)),
    );
  }

  addViolation(violation: CheckerViolation): void {
    this.violations.push(violation);
  }

  async checkUpgradeBeacon(
    chain: Chain,
    name: string,
    proxiedAddress: BeaconProxyAddresses,
  ): Promise<void> {
    const dc = this.multiProvider.getChainConnection(chain);
    const implementation = await upgradeBeaconImplementation(
      dc.provider,
      proxiedAddress.beacon,
    );
    if (implementation !== proxiedAddress.implementation) {
      this.addViolation(
        upgradeBeaconViolation(chain, name, proxiedAddress, implementation),
      );
    }
  }

  async checkOwnership(
    chain: Chain,
    owner: types.Address,
    ownables: Ownable[],
  ): Promise<void> {
    await Promise.all(
      ownables.map(async (contract) => {
        const actual = await contract.owner();
        if (actual.toLowerCase() != owner.toLowerCase()) {
          const violation: OwnerViolation = {
            chain,
            type: ViolationType.Owner,
            actual,
            expected: owner,
            contract,
          };
          this.addViolation(violation);
        }
      }),
    );
  }

  expectViolations(types: string[], expectedMatches: number[]): void {
    // Every type should have exactly the number of expected matches.
    const actualMatches = types.map(
      (t) => this.violations.map((v) => v.type === t).filter(Boolean).length,
    );
    actualMatches.map((actual, index) => {
      const expected = expectedMatches[index];
      utils.assert(
        actual == expected,
        `Expected ${expected} ${types[index]} violations, got ${actual}`,
      );
    });
    // Every violation should be matched by at least one partial.
    const unmatched = this.violations.map(
      (v) => types.map((t) => v.type === t).filter(Boolean).length,
    );
    unmatched.map((count, index) => {
      utils.assert(
        count > 0,
        `Expected 0 ${this.violations[index].type} violations, got ${count}`,
      );
    });
  }

  expectEmpty(): void {
    const count = this.violations.length;
    utils.assert(count === 0, `Found ${count} violations`);
  }
}
