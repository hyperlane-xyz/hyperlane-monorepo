import { utils } from '@abacus-network/utils';
import type { types } from '@abacus-network/utils';

import { AbacusApp } from '../AbacusApp';
import { MultiProvider } from '../providers/MultiProvider';
import { BeaconProxyAddresses } from '../proxy';
import { ChainMap, ChainName } from '../types';

import { upgradeBeaconImplementation, upgradeBeaconViolation } from './proxy';
import { CheckerViolation } from './types';

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

  async check(): Promise<void[]> {
    return Promise.all(
      this.app.chains().map((chain) => this.checkChain(chain)),
    );
  }

  addViolation(violation: CheckerViolation): void {
    if (!this.isDuplicateViolation(violation)) {
      this.violations.push(violation);
    }
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

  static async checkOwnership(
    owner: types.Address,
    ownables: Ownable[],
  ): Promise<void> {
    const owners = await Promise.all(ownables.map((o) => o.owner()));
    owners.map((_) => utils.assert(_ == owner));
  }

  isDuplicateViolation(violation: CheckerViolation): boolean {
    const duplicates = this.violations.filter(
      (v) =>
        violation.type === v.type &&
        violation.chain === v.chain &&
        violation.actual === v.actual &&
        violation.expected === v.expected,
    );
    return duplicates.length > 0;
  }

  expectViolations(types: string[], expectedMatches: number[]): void {
    // Every type should have exactly the number of expected matches.
    const actualMatches = types.map(
      (t) => this.violations.map((v) => v.type === t).filter(Boolean).length,
    );
    utils.assert(utils.deepEquals(actualMatches, expectedMatches));
    // Every violation should be matched by at least one partial.
    const unmatched = this.violations.map(
      (v) => types.map((t) => v.type === t).filter(Boolean).length,
    );
    utils.assert(!unmatched.includes(0));
  }

  expectEmpty(): void {
    utils.assert(this.violations.length === 0);
  }
}
