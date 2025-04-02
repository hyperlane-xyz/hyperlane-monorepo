import { BigNumber } from '@ethersproject/bignumber';
import { Provider } from '@ethersproject/providers';

import {
  AccessControl__factory,
  IBaseSlasher__factory,
  IBurnerRouter__factory,
  IDefaultStakerRewards__factory,
  INetworkRestakeDelegator__factory,
  IVaultTokenized__factory,
  Ownable__factory,
  TimelockController__factory,
} from '@hyperlane-xyz/core';
import { CheckerViolation, MultiProvider } from '@hyperlane-xyz/sdk';
import { eqAddress, rootLogger } from '@hyperlane-xyz/utils';

enum SymbioticViolationType {
  State = 'State',
  AccessControl = 'AccessControl',
}

interface SymbioticViolation extends CheckerViolation {
  type: SymbioticViolationType;
  contractName: string;
  referenceField: string;
  account?: string;
}

interface SymbioticConfig {
  chain: string;
  network: {
    address: string;
  };
  accessManager: {
    address: string;
  };
  vault: {
    address: string;
    epochDuration: number;
  };
  // delegator: {
  //   networkLimit?: any;
  //   operatorNetworkShares?: any;
  // };
  rewards: {
    address: string;
    adminFee: number;
  };
  burner: {
    owner: string;
  };
}

export interface DerivedContracts {
  slasher: string;
  delegator: string;
  burnerRouter: string;
  collateral: string;
}

export class SymbioticChecker {
  readonly violations: CheckerViolation[] = [];
  private provider: Provider;
  private logger = rootLogger.child({ module: 'SymbioticChecker' });

  constructor(
    readonly multiProvider: MultiProvider,
    readonly config: SymbioticConfig,
    readonly derivedContractAddresses: DerivedContracts,
  ) {
    this.provider = this.multiProvider.getProvider(this.config.chain);
  }

  static async deriveContractAddresses(
    chain: string,
    multiProvider: MultiProvider,
    vaultAddress: string,
  ): Promise<DerivedContracts> {
    const provider = multiProvider.getProvider(chain);
    const vault = IVaultTokenized__factory.connect(vaultAddress, provider);
    return {
      slasher: await vault.slasher(),
      delegator: await vault.delegator(),
      burnerRouter: await vault.burner(),
      collateral: await vault.collateral(),
    };
  }

  async check(): Promise<void> {
    await this.checkVault();
    await this.checkDelegator();
    await this.checkSlasher();
    await this.checkBurner();
    await this.checkRewards();
    await this.checkNetwork();
  }

  private async checkVault(): Promise<void> {
    const vault = IVaultTokenized__factory.connect(
      this.config.vault.address,
      this.provider,
    );

    const actualEpochDuration = await vault.epochDuration();
    if (actualEpochDuration !== this.config.vault.epochDuration) {
      const violation: SymbioticViolation = {
        chain: this.config.chain,
        type: SymbioticViolationType.State,
        contractName: 'vault',
        referenceField: 'epochDuration',
        actual: actualEpochDuration,
        expected: this.config.vault.epochDuration,
      };
      this.addViolation(violation);
    }

    const roleIds = {
      depositWhitelistSetter: await vault.DEPOSIT_WHITELIST_SET_ROLE(),
      depositWhitelist: await vault.DEPOSITOR_WHITELIST_ROLE(),
      isDepositLimitSetter: await vault.IS_DEPOSIT_LIMIT_SET_ROLE(),
      depositLimitSetter: await vault.DEPOSIT_LIMIT_SET_ROLE(),
    };

    await this.checkAccessControl(
      this.config.vault.address,
      'vault',
      roleIds,
      this.config.accessManager.address,
    );
  }

  private async checkDelegator(): Promise<void> {
    const delegator = INetworkRestakeDelegator__factory.connect(
      this.derivedContractAddresses.delegator,
      this.provider,
    );

    const actualVault = await delegator.vault();
    if (!eqAddress(actualVault, this.config.vault.address)) {
      const violation: SymbioticViolation = {
        chain: this.config.chain,
        type: SymbioticViolationType.State,
        contractName: 'delegator',
        referenceField: 'vault',
        actual: actualVault,
        expected: this.config.vault.address,
      };
      this.addViolation(violation);
    }

    // TODO subnetwork checks

    const roleIds = {
      networkLimitSetter: await delegator.NETWORK_LIMIT_SET_ROLE(),
      operatorNetworkSharesSetter:
        await delegator.OPERATOR_NETWORK_SHARES_SET_ROLE(),
    };

    await this.checkAccessControl(
      this.derivedContractAddresses.delegator,
      'delegator',
      roleIds,
      this.config.accessManager.address,
    );
  }

  private async checkSlasher(): Promise<void> {
    const slasher = IBaseSlasher__factory.connect(
      this.derivedContractAddresses.slasher,
      this.provider,
    );

    const actualVault = await slasher.vault();
    if (!eqAddress(actualVault, this.config.vault.address)) {
      const violation: SymbioticViolation = {
        chain: this.config.chain,
        type: SymbioticViolationType.State,
        contractName: 'slasher',
        referenceField: 'vault',
        actual: actualVault,
        expected: this.config.vault.address,
      };
      this.addViolation(violation);
    }

    const isBurnerHook = await slasher.isBurnerHook();
    if (!isBurnerHook) {
      const violation: SymbioticViolation = {
        chain: this.config.chain,
        type: SymbioticViolationType.State,
        contractName: 'slasher',
        referenceField: 'isBurnerHook',
        actual: false,
        expected: true,
      };
      this.addViolation(violation);
    }
  }

  private async checkBurner(): Promise<void> {
    const burnerRouter = IBurnerRouter__factory.connect(
      this.derivedContractAddresses.burnerRouter,
      this.provider,
    );

    const actualCollateral = await burnerRouter.collateral();

    if (
      !eqAddress(actualCollateral, this.derivedContractAddresses.collateral)
    ) {
      const violation: SymbioticViolation = {
        chain: this.config.chain,
        type: SymbioticViolationType.State,
        contractName: 'burner',
        referenceField: 'collateral',
        actual: actualCollateral,
        expected: this.derivedContractAddresses.collateral,
      };
      this.addViolation(violation);
    }

    const actualNetworkReceiver = await burnerRouter.networkReceiver(
      this.config.network.address,
    );
    if (
      !eqAddress(actualNetworkReceiver, this.derivedContractAddresses.slasher)
    ) {
      const violation: SymbioticViolation = {
        chain: this.config.chain,
        type: SymbioticViolationType.State,
        contractName: 'burner',
        referenceField: 'networkReceiver',
        actual: actualNetworkReceiver,
        expected: this.derivedContractAddresses.slasher,
      };
      this.addViolation(violation);
    }

    const ownableBurner = Ownable__factory.connect(
      this.derivedContractAddresses.burnerRouter,
      this.provider,
    );
    const owner = await ownableBurner.owner();
    if (!eqAddress(owner, this.config.burner.owner)) {
      const violation: SymbioticViolation = {
        chain: this.config.chain,
        type: SymbioticViolationType.State,
        contractName: 'burner',
        referenceField: 'owner',
        actual: owner,
        expected: this.config.burner.owner,
      };
      this.addViolation(violation);
    }
  }

  private async checkRewards(): Promise<void> {
    // TODO: remove try catch when we have the correct address for the rewards contract
    const rewards = IDefaultStakerRewards__factory.connect(
      this.config.rewards.address,
      this.provider,
    );

    let actualVault: string;
    try {
      actualVault = await rewards.VAULT();
      if (!eqAddress(actualVault, this.config.vault.address)) {
        const violation: SymbioticViolation = {
          chain: this.config.chain,
          type: SymbioticViolationType.State,
          contractName: 'rewards',
          referenceField: 'vault',
          actual: actualVault,
          expected: this.config.vault.address,
        };
        this.addViolation(violation);
      }
    } catch (e) {
      this.logger.error(`Error reading vault from rewards contract: ${e}`);
    }

    let actualAdminFee: BigNumber;
    try {
      actualAdminFee = await rewards.adminFee();
      const expectedAdminFee = BigNumber.from(this.config.rewards.adminFee);
      if (actualAdminFee.toString() !== expectedAdminFee.toString()) {
        const violation: SymbioticViolation = {
          chain: this.config.chain,
          type: SymbioticViolationType.State,
          contractName: 'rewards',
          referenceField: 'adminFee',
          actual: actualAdminFee.toString(),
          expected: expectedAdminFee.toString(),
        };
        this.addViolation(violation);
      }
    } catch (e) {
      this.logger.error(`Error reading adminFee from rewards contract: ${e}`);
    }

    try {
      const roleIds = {
        adminFeeClaim: await rewards.ADMIN_FEE_CLAIM_ROLE(),
        adminFeeSet: await rewards.ADMIN_FEE_SET_ROLE(),
      };

      await this.checkAccessControl(
        this.config.rewards.address,
        'rewards',
        roleIds,
        this.config.accessManager.address,
      );
    } catch (e) {
      this.logger.error(`Error checking access control for rewards: ${e}`);
    }
  }

  private async checkNetwork(): Promise<void> {
    const network = TimelockController__factory.connect(
      this.config.network.address,
      this.provider,
    );

    const roleIds = {
      executor: await network.EXECUTOR_ROLE(),
      proposer: await network.PROPOSER_ROLE(),
      canceller: await network.CANCELLER_ROLE(),
      admin: await network.TIMELOCK_ADMIN_ROLE(),
    };

    await this.checkAccessControl(
      this.config.network.address,
      'network',
      roleIds,
      this.config.accessManager.address,
    );
  }

  private addViolation(violation: CheckerViolation): void {
    this.violations.push(violation);
  }

  expectEmpty(): void {
    const count = this.violations.length;
    if (count !== 0) {
      throw new Error(`Found ${count} violations`);
    }
  }

  logViolationsTable(): void {
    if (this.violations.length > 0) {
      console.table(this.violations, [
        'type',
        'chain',
        'contractName',
        'referenceField',
        'account',
        'actual',
        'expected',
      ]);
    } else {
      console.info('Symbiotic Checker found no violations');
    }
  }

  private async checkAccessControl(
    contractAddress: string,
    contractName: string,
    roleIds: Record<string, string>,
    account: string,
  ): Promise<void> {
    const accessControl = AccessControl__factory.connect(
      contractAddress,
      this.provider,
    );

    for (const [role, roleId] of Object.entries(roleIds)) {
      const hasRole = await accessControl.hasRole(roleId, account);
      if (!hasRole) {
        const violation: SymbioticViolation = {
          type: SymbioticViolationType.AccessControl,
          chain: this.config.chain,
          account,
          actual: false,
          expected: true,
          contractName,
          referenceField: role,
        };
        this.addViolation(violation);
      }
    }
  }
}
