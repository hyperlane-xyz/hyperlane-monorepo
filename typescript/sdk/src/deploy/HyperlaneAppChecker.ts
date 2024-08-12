import { utils } from 'ethers';

import { Ownable, TimelockController__factory } from '@hyperlane-xyz/core';
import {
  Address,
  ProtocolType,
  assert,
  eqAddress,
  objMap,
  promiseObjAll,
} from '@hyperlane-xyz/utils';

import { HyperlaneApp } from '../app/HyperlaneApp.js';
import { BytecodeHash } from '../consts/bytecode.js';
import { filterOwnableContracts } from '../contracts/contracts.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { ChainMap, ChainName } from '../types.js';

import { UpgradeConfig, isProxy, proxyAdmin } from './proxy.js';
import {
  AccessControlViolation,
  BytecodeMismatchViolation,
  CheckerViolation,
  OwnerViolation,
  ProxyAdminViolation,
  TimelockControllerViolation,
  ViolationType,
} from './types.js';

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
      .filter(
        (chain) =>
          this.multiProvider.getChainMetadata(chain).protocol ===
            ProtocolType.Ethereum && !this.app.chains().includes(chain),
      )
      .forEach((chain: string) =>
        this.addViolation({
          type: ViolationType.NotDeployed,
          chain,
          expected: '',
          actual: '',
        }),
      );

    return Promise.all(
      // this.app.chains() will only return Ethereum chains that can be interacted with.
      this.app.chains().map((chain) => this.checkChain(chain)),
    );
  }

  addViolation(violation: CheckerViolation): void {
    this.violations.push(violation);
  }

  async checkProxiedContracts(
    chain: ChainName,
    proxyAdminAddress?: Address,
  ): Promise<void> {
    const expectedAdmin =
      proxyAdminAddress ?? this.app.getContracts(chain).proxyAdmin.address;
    if (!expectedAdmin) {
      throw new Error(
        `Checking proxied contracts for ${chain} with no admin provided`,
      );
    }
    const provider = this.multiProvider.getProvider(chain);
    const contracts = this.app.getContracts(chain);

    await promiseObjAll(
      objMap(contracts, async (name, contract) => {
        if (await isProxy(provider, contract.address)) {
          // Check the ProxiedContract's admin matches expectation
          const actualAdmin = await proxyAdmin(provider, contract.address);
          if (!eqAddress(actualAdmin, expectedAdmin)) {
            this.addViolation({
              type: ViolationType.ProxyAdmin,
              chain,
              name,
              expected: expectedAdmin,
              actual: actualAdmin,
            } as ProxyAdminViolation);
          }
        }
      }),
    );
  }

  async checkUpgrade(
    chain: ChainName,
    upgradeConfig: UpgradeConfig,
  ): Promise<void> {
    const proxyOwner = await this.app.getContracts(chain).proxyAdmin.owner();
    const timelockController = TimelockController__factory.connect(
      proxyOwner,
      this.multiProvider.getProvider(chain),
    );

    const minDelay = (await timelockController.getMinDelay()).toNumber();

    if (minDelay !== upgradeConfig.timelock.delay) {
      const violation: TimelockControllerViolation = {
        type: ViolationType.TimelockController,
        chain,
        actual: minDelay,
        expected: upgradeConfig.timelock.delay,
        contract: timelockController,
      };
      this.addViolation(violation);
    }

    const roleIds = {
      executor: await timelockController.EXECUTOR_ROLE(),
      proposer: await timelockController.PROPOSER_ROLE(),
      canceller: await timelockController.CANCELLER_ROLE(),
      admin: await timelockController.TIMELOCK_ADMIN_ROLE(),
    };

    const accountHasRole = await promiseObjAll(
      objMap(upgradeConfig.timelock.roles, async (role, account) => ({
        hasRole: await timelockController.hasRole(roleIds[role], account),
        account,
      })),
    );

    for (const [role, { hasRole, account }] of Object.entries(accountHasRole)) {
      if (!hasRole) {
        const violation: AccessControlViolation = {
          type: ViolationType.AccessControl,
          chain,
          account,
          actual: false,
          expected: true,
          contract: timelockController,
          role,
        };
        this.addViolation(violation);
      }
    }
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
    const bytecodeHash = utils.keccak256(
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

  protected async checkProxy(
    chain: ChainName,
    name: string,
    address: string,
  ): Promise<void> {
    return this.checkBytecode(chain, name, address, [
      BytecodeHash.TRANSPARENT_PROXY_BYTECODE_HASH,
      BytecodeHash.TRANSPARENT_PROXY_4_9_3_BYTECODE_HASH,
      BytecodeHash.OPT_TRANSPARENT_PROXY_BYTECODE_HASH,
    ]);
  }

  async ownables(chain: ChainName): Promise<{ [key: string]: Ownable }> {
    const contracts = this.app.getContracts(chain);
    return filterOwnableContracts(contracts);
  }

  protected async checkOwnership(
    chain: ChainName,
    owner: Address,
    ownableOverrides?: Record<string, Address>,
  ): Promise<void> {
    const ownableContracts = await this.ownables(chain);
    for (const [name, contract] of Object.entries(ownableContracts)) {
      const expectedOwner = ownableOverrides?.[name] ?? owner;
      const actual = await contract.owner();
      if (!eqAddress(actual, expectedOwner)) {
        const violation: OwnerViolation = {
          chain,
          name,
          type: ViolationType.Owner,
          actual,
          expected: expectedOwner,
          contract,
        };
        this.addViolation(violation);
      }
    }
  }

  expectViolations(violationCounts: Record<string, number>): void {
    // Every type should have exactly the number of expected matches.
    objMap(violationCounts, (type, count) => {
      const actual = this.violations.filter((v) => v.type === type).length;
      assert(
        actual == count,
        `Expected ${count} ${type} violations, got ${actual}`,
      );
    });
    this.violations
      .filter((v) => !(v.type in violationCounts))
      .map((v) => {
        assert(false, `Unexpected violation: ${JSON.stringify(v)}`);
      });
  }

  expectEmpty(): void {
    const count = this.violations.length;
    assert(count === 0, `Found ${count} violations`);
  }

  logViolationsTable(): void {
    const violations = this.violations;
    if (violations.length > 0) {
      // eslint-disable-next-line no-console
      console.table(violations, [
        'chain',
        'remote',
        'name',
        'type',
        'subType',
        'actual',
        'expected',
        'description',
      ]);
    } else {
      // eslint-disable-next-line no-console
      console.info(`${module} Checker found no violations`);
    }
  }
}
