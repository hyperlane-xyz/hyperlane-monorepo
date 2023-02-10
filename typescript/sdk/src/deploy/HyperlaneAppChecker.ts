import { Ownable } from '@hyperlane-xyz/core';
import type { types } from '@hyperlane-xyz/utils';
import { utils } from '@hyperlane-xyz/utils';

import { HyperlaneApp } from '../HyperlaneApp';
import { MultiProvider } from '../providers/MultiProvider';
import { TransparentProxyAddresses } from '../proxy';
import { ChainMap, ChainName } from '../types';
import { objMap } from '../utils/objects';

import { proxyAdmin, proxyImplementation, proxyViolation } from './proxy';
import { CheckerViolation, OwnerViolation, ViolationType } from './types';

export abstract class HyperlaneAppChecker<
  App extends HyperlaneApp<any>,
  Config,
> {
  readonly multiProvider: MultiProvider;
  readonly app: App;
  readonly configMap: ChainMap<Config>;
  readonly violations: CheckerViolation[];

  constructor(
    multiProvider: MultiProvider,
    app: App,
    configMap: ChainMap<Config>,
  ) {
    this.multiProvider = multiProvider;
    this.app = app;
    this.violations = [];
    this.configMap = configMap;
  }

  abstract checkChain(chain: ChainName): Promise<void>;

  async check(): Promise<void[]> {
    Object.keys(this.configMap)
      .filter((_) => !this.app.chains().includes(_))
      .forEach((chain: string) =>
        this.addViolation({
          type: ViolationType.NotDeployed,
          chain,
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
    chain: ChainName,
    name: string,
    proxiedAddress: TransparentProxyAddresses,
    proxyAdminAddress?: types.Address,
  ): Promise<void> {
    const provider = this.multiProvider.getProvider(chain);
    const implementation = await proxyImplementation(
      provider,
      proxiedAddress.proxy,
    );
    if (implementation !== proxiedAddress.implementation) {
      this.addViolation(
        proxyViolation(chain, name, proxiedAddress, implementation),
      );
    }
    if (proxyAdminAddress) {
      const admin = await proxyAdmin(provider, proxiedAddress.proxy);
      utils.assert(admin === proxyAdminAddress, 'Proxy admin mismatch');
    }
  }

  async checkOwnership(
    chain: ChainName,
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

  expectViolations(violationCounts: Record<string, number>): void {
    // Every type should have exactly the number of expected matches.
    objMap(violationCounts, (type, count) => {
      const actual = this.violations.filter((v) => v.type === type).length;
      utils.assert(
        actual == count,
        `Expected ${count} ${type} violations, got ${actual}`,
      );
    });
    this.violations
      .filter((v) => !(v.type in violationCounts))
      .map((v) => {
        utils.assert(false, `Unexpected violation: ${JSON.stringify(v)}`);
      });
  }

  expectEmpty(): void {
    const count = this.violations.length;
    utils.assert(count === 0, `Found ${count} violations`);
  }
}
