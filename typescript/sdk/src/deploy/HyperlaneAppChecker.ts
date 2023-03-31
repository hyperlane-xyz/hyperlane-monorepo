import { keccak256 } from 'ethers/lib/utils';

import { Ownable } from '@hyperlane-xyz/core';
import type { types } from '@hyperlane-xyz/utils';
import { utils } from '@hyperlane-xyz/utils';

import { HyperlaneApp } from '../HyperlaneApp';
import { MultiProvider } from '../providers/MultiProvider';
import { ProxiedContract, isProxiedContract } from '../proxy';
import { ChainMap, ChainName } from '../types';
import { objMap, promiseObjAll } from '../utils/objects';

import { proxyAdmin } from './proxy';
import {
  BytecodeMismatchViolation,
  CheckerViolation,
  OwnerViolation,
  ProxyAdminViolation,
  ViolationType,
} from './types';

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

  async checkProxiedContracts(chain: ChainName): Promise<void> {
    const expectedAdmin = this.app.getContracts(chain).proxyAdmin.address;
    if (!expectedAdmin) {
      throw new Error(
        `Checking proxied contracts for ${chain} with no admin provided`,
      );
    }
    const provider = this.multiProvider.getProvider(chain);
    const isProxied = (
      _: string,
      contract: any,
    ): contract is ProxiedContract<any, any> => {
      return isProxiedContract(contract);
    };
    const proxied = this.app.getFlattenedFilteredContracts(chain, isProxied);
    await promiseObjAll(
      objMap(proxied, async (name, contract) => {
        // Check the ProxiedContract's admin matches expectation
        const actualAdmin = await proxyAdmin(provider, contract.address);
        if (!utils.eqAddress(actualAdmin, expectedAdmin)) {
          this.addViolation({
            type: ViolationType.ProxyAdmin,
            chain,
            name,
            expected: expectedAdmin,
            actual: actualAdmin,
          } as ProxyAdminViolation);
        }
      }),
    );
  }

  private removeBytecodeMetadata(bytecode: string): string {
    // https://docs.soliditylang.org/en/v0.8.17/metadata.html#encoding-of-the-metadata-hash-in-the-bytecode
    // Remove solc metadata from bytecode
    return bytecode.substring(0, bytecode.length - 90);
  }

  // This method checks whether the bytecode of a contract matches the expected bytecode. It forces the deployer to explicitly acknowledge a change in bytecode. The violations can be remediated by updating the expected bytecode hash.
  async checkBytecode(
    chain: ChainName,
    name: string,
    address: string,
    expectedBytecodeHashes: string[],
    modifyBytecodePriorToHash: (bytecode: string) => string = (_) => _,
  ): Promise<void> {
    const provider = this.multiProvider.getProvider(chain);
    const bytecode = await provider.getCode(address);
    const bytecodeHash = keccak256(
      modifyBytecodePriorToHash(this.removeBytecodeMetadata(bytecode)),
    );
    if (!expectedBytecodeHashes.includes(bytecodeHash)) {
      this.addViolation({
        type: ViolationType.BytecodeMismatch,
        chain,
        expected: expectedBytecodeHashes,
        actual: bytecodeHash,
        name,
      } as BytecodeMismatchViolation);
    }
  }

  // TODO: Require owner in config if ownables is non-empty
  async checkOwnership(chain: ChainName, owner: types.Address): Promise<void> {
    const isOwnable = (_: string, contract: any): contract is Ownable => {
      return (
        contract !== null &&
        typeof contract === 'object' &&
        contract.owner &&
        contract.transferOwnership
      );
    };
    const ownables = this.app.getFlattenedFilteredContracts(chain, isOwnable);
    await promiseObjAll(
      objMap(ownables, async (name, contract) => {
        const actual = await contract.owner();
        if (!utils.eqAddress(actual, owner)) {
          const violation: OwnerViolation = {
            chain,
            name,
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
