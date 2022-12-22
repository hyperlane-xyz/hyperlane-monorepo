import { Ownable } from '@hyperlane-xyz/core';
import { utils } from '@hyperlane-xyz/utils';
import type { types } from '@hyperlane-xyz/utils';

import { HyperlaneApp } from '../HyperlaneApp';
import { MultiProvider } from '../providers/MultiProvider';
import { TransparentProxyAddresses } from '../proxy';
import { ChainMap, ChainName } from '../types';

import { proxyAdmin, proxyImplementation, proxyViolation } from './proxy';
import { CheckerViolation, OwnerViolation, ViolationType } from './types';

export abstract class HyperlaneAppChecker<
  Chain extends ChainName,
  App extends HyperlaneApp<any, Chain>,
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
    Object.keys(this.configMap)
      .filter((_) => !this.app.chains().includes(_ as Chain))
      .forEach((chain: string) =>
        this.addViolation({
          type: ViolationType.NotDeployed,
          chain: chain as Chain,
          expected: '',
          actual: '',
        }),
      );

    return Promise.all(
      this.app.chains().map((chain) => this.checkChain(chain)),
    );
  }

  addViolation(violation: CheckerViolation): void {
    this.violations.push(violation);
  }

  async checkProxiedContract(
    chain: Chain,
    name: string,
    proxiedAddress: TransparentProxyAddresses,
    proxyAdminAddress?: types.Address,
  ): Promise<void> {
    const dc = this.multiProvider.getChainConnection(chain);
    const implementation = await proxyImplementation(
      dc.provider,
      proxiedAddress.proxy,
    );
    if (implementation !== proxiedAddress.implementation) {
      this.addViolation(
        proxyViolation(chain, name, proxiedAddress, implementation),
      );
    }
    if (proxyAdminAddress) {
      const admin = await proxyAdmin(dc.provider, proxiedAddress.proxy);
      utils.assert(admin === proxyAdminAddress, 'Proxy admin mismatch');
    }
  }

  async checkOwnership(
    chain: Chain,
    owner: types.Address,
    ownables: Ownable[],
  ): Promise<void> {
    await Promise.all(
      ownables.map(async (contract) => {
        console.log('checking ownership of', contract.address);
        const actual = await contract.owner();
        console.log('got owner of', contract.address);
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
