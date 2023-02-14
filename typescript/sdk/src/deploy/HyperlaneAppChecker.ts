import { keccak256 } from 'ethers/lib/utils';

import { Ownable } from '@hyperlane-xyz/core';
import { utils } from '@hyperlane-xyz/utils';
import type { types } from '@hyperlane-xyz/utils';

import { HyperlaneApp } from '../HyperlaneApp';
import { MultiProvider } from '../providers/MultiProvider';
import { TransparentProxyAddresses } from '../proxy';
import { ChainMap, ChainName } from '../types';
import { objMap } from '../utils/objects';

import { proxyAdmin, proxyImplementation, proxyViolation } from './proxy';
import {
  BytecodeMismatchViolation,
  CheckerViolation,
  OwnerViolation,
  ViolationType,
} from './types';

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

  private removeBytecodeMetadata(bytecode: string): string {
    // https://docs.soliditylang.org/en/v0.8.17/metadata.html#encoding-of-the-metadata-hash-in-the-bytecode
    // Remove solc metadata from bytecode
    return bytecode.substring(0, bytecode.length - 90);
  }

  // This method checks whether the bytecode of a contract matches the expected bytecode. It forces the deployer to explicitly acknowledge a change in bytecode. The violations can be remediated by updating the expected bytecode hash.
  async checkBytecode(
    chain: Chain,
    name: string,
    address: string,
    expectedBytecodeHash: string,
    modifyBytecodePriorToHash: (bytecode: string) => string = (_) => _,
  ): Promise<void> {
    const provider = this.multiProvider.getChainProvider(chain);
    const bytecode = await provider.getCode(address);
    const bytecodeHash = keccak256(
      modifyBytecodePriorToHash(this.removeBytecodeMetadata(bytecode)),
    );
    if (bytecodeHash !== expectedBytecodeHash) {
      this.addViolation({
        type: ViolationType.BytecodeMismatch,
        chain,
        expected: expectedBytecodeHash,
        actual: bytecodeHash,
        name,
      } as BytecodeMismatchViolation);
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
