import { utils } from 'ethers';

import {
  Ownable,
  ProxyAdmin__factory,
  TimelockController__factory,
} from '@hyperlane-xyz/core';
import {
  Address,
  ProtocolType,
  assert,
  eqAddress,
  objMap,
  promiseObjAll,
  rootLogger,
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
  readonly violations: CheckerViolation[] = [];

  constructor(
    readonly multiProvider: MultiProvider,
    readonly app: App,
    readonly configMap: ChainMap<Config>,
  ) {}

  abstract checkChain(chain: ChainName): Promise<void>;

  async check(chainsToCheck?: ChainName[]): Promise<void[]> {
    // Get all EVM chains from config
    const evmChains = this.getEvmChains();

    // Mark any EVM chains that are not deployed
    const appChains = this.app.chains();
    for (const chain of evmChains) {
      if (!appChains.includes(chain)) {
        this.addViolation({
          type: ViolationType.NotDeployed,
          chain,
          expected: '',
          actual: '',
        });
      }
    }

    // Finally, check the chains that were explicitly requested
    // If no chains were requested, check all app chains
    const chains =
      !chainsToCheck || chainsToCheck.length === 0 ? appChains : chainsToCheck;
    return Promise.all(
      chains
        .filter(
          (chain) =>
            this.multiProvider.getChainMetadata(chain).protocol ===
            ProtocolType.Ethereum,
        )
        .map((chain) => this.checkChain(chain)),
    );
  }

  getEvmChains(): ChainName[] {
    return Object.keys(this.configMap).filter(
      (chain) =>
        this.multiProvider.getChainMetadata(chain).protocol ===
        ProtocolType.Ethereum,
    );
  }

  addViolation(violation: CheckerViolation): void {
    if (violation.type === ViolationType.BytecodeMismatch) {
      rootLogger.warn({ violation }, `Found bytecode mismatch. Ignoring...`);
      return;
    }
    this.violations.push(violation);
  }

  async checkProxiedContracts(
    chain: ChainName,
    owner: Address,
    ownableOverrides?: Record<string, Address>,
  ): Promise<void> {
    // expectedProxyAdminAddress may be undefined, this means that proxyAdmin is not set in the config/not known at deployment time
    const expectedProxyAdminAddress =
      this.app.getContracts(chain).proxyAdmin?.address;
    const provider = this.multiProvider.getProvider(chain);

    const contracts = this.app.getContracts(chain);
    await promiseObjAll(
      objMap(contracts, async (name, contract) => {
        if (await isProxy(provider, contract.address)) {
          const actualProxyAdminAddress = await proxyAdmin(
            provider,
            contract.address,
          );

          if (expectedProxyAdminAddress) {
            // config defines an expected ProxyAdmin address, we therefore check if the actual ProxyAdmin address matches the expected one
            if (
              !eqAddress(actualProxyAdminAddress, expectedProxyAdminAddress)
            ) {
              this.addViolation({
                type: ViolationType.ProxyAdmin,
                chain,
                name,
                expected: expectedProxyAdminAddress,
                actual: actualProxyAdminAddress,
                proxyAddress: contract.address,
              } as ProxyAdminViolation);
            }
          } else {
            // config does not define an expected ProxyAdmin address, this means that checkOwnership will not be able to check the ownership of the ProxyAdmin contract
            // as it is not explicitly defined in the config. We therefore check the ownership of the ProxyAdmin contract here.
            const actualProxyAdminContract = ProxyAdmin__factory.connect(
              actualProxyAdminAddress,
              provider,
            );
            const actualProxyAdminOwner =
              await actualProxyAdminContract.owner();
            const expectedOwner = this.getOwner(
              owner,
              'proxyAdmin',
              ownableOverrides,
            );
            if (!eqAddress(actualProxyAdminOwner, expectedOwner)) {
              const violation: OwnerViolation = {
                chain,
                name: 'proxyAdmin',
                type: ViolationType.Owner,
                actual: actualProxyAdminOwner,
                expected: expectedOwner,
                contract: actualProxyAdminContract,
              };
              this.addViolation(violation);
            }
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

  protected getOwner(
    owner: Address,
    contractName: string,
    ownableOverrides?: Record<string, Address>,
  ): Address {
    return ownableOverrides?.[contractName] ?? owner;
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
      const expectedOwner = this.getOwner(owner, name, ownableOverrides);
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
