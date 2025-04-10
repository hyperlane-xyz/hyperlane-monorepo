import { BigNumber } from '@ethersproject/bignumber';
import { Provider } from '@ethersproject/providers';

import {
  AccessControl,
  AccessControl__factory,
  IBaseSlasher__factory,
  IBurnerRouter__factory,
  ICompoundStakerRewards,
  IDefaultStakerRewards__factory,
  INetworkRestakeDelegator__factory,
  IVaultTokenized,
  IVaultTokenized__factory,
  Ownable__factory,
  TimelockController,
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

export interface SymbioticConfig {
  chain: string;
  vault: {
    epochDuration: number;
  };
  // delegator: {
  //   networkLimit?: any;
  //   operatorNetworkShares?: any;
  // };
  rewards: {
    adminFee: number;
  };
  burner: {
    owner: string;
  };
}

export interface SymbioticAddresses {
  network: string;
  accessManager: string;
}

export interface SymbioticContracts {
  compoundStakerRewards: ICompoundStakerRewards;
  network: TimelockController;
  accessManager: AccessControl;
}

export class SymbioticChecker {
  readonly violations: CheckerViolation[] = [];
  private provider: Provider;
  private logger = rootLogger.child({ module: 'SymbioticChecker' });

  constructor(
    readonly multiProvider: MultiProvider,
    readonly config: SymbioticConfig,
    readonly contracts: SymbioticContracts,
  ) {
    this.provider = this.multiProvider.getProvider(this.config.chain);
  }

  async check(): Promise<void> {
    const vaultAddress = await this.contracts.compoundStakerRewards.vault();
    const vault = IVaultTokenized__factory.connect(vaultAddress, this.provider);

    const delegatorAddress = await vault.delegator();
    const slasherAddress = await vault.slasher();
    const burnerRouterAddress = await vault.burner();
    const collateralAddress = await vault.collateral();

    await this.checkVault(vault);
    await this.checkDelegator(delegatorAddress, vaultAddress);
    await this.checkSlasher(slasherAddress, vaultAddress);
    await this.checkBurner(burnerRouterAddress, collateralAddress);
    await this.checkRewards(vaultAddress);
    await this.checkNetwork();
  }

  private async checkVault(vault: IVaultTokenized): Promise<void> {
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
      vault.address,
      'vault',
      roleIds,
      this.contracts.accessManager.address,
    );
  }

  private async checkDelegator(
    delegatorAddress: string,
    vaultAddress: string,
  ): Promise<void> {
    const delegator = INetworkRestakeDelegator__factory.connect(
      delegatorAddress,
      this.provider,
    );

    const actualVault = await delegator.vault();
    if (!eqAddress(actualVault, vaultAddress)) {
      const violation: SymbioticViolation = {
        chain: this.config.chain,
        type: SymbioticViolationType.State,
        contractName: 'delegator',
        referenceField: 'vault',
        actual: actualVault,
        expected: vaultAddress,
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
      delegatorAddress,
      'delegator',
      roleIds,
      this.contracts.accessManager.address,
    );
  }

  private async checkSlasher(
    slasherAddress: string,
    vaultAddress: string,
  ): Promise<void> {
    const slasher = IBaseSlasher__factory.connect(
      slasherAddress,
      this.provider,
    );

    const actualVault = await slasher.vault();
    if (!eqAddress(actualVault, vaultAddress)) {
      const violation: SymbioticViolation = {
        chain: this.config.chain,
        type: SymbioticViolationType.State,
        contractName: 'slasher',
        referenceField: 'vault',
        actual: actualVault,
        expected: vaultAddress,
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

  private async checkBurner(
    burnerRouterAddress: string,
    collateralAddress: string,
  ): Promise<void> {
    const burnerRouter = IBurnerRouter__factory.connect(
      burnerRouterAddress,
      this.provider,
    );

    const actualCollateral = await burnerRouter.collateral();

    if (!eqAddress(actualCollateral, collateralAddress)) {
      const violation: SymbioticViolation = {
        chain: this.config.chain,
        type: SymbioticViolationType.State,
        contractName: 'burner',
        referenceField: 'collateral',
        actual: actualCollateral,
        expected: collateralAddress,
      };
      this.addViolation(violation);
    }

    const actualGlobalReceiver = await burnerRouter.globalReceiver();
    if (
      !eqAddress(actualGlobalReceiver, this.contracts.accessManager.address)
    ) {
      const violation: SymbioticViolation = {
        chain: this.config.chain,
        type: SymbioticViolationType.State,
        contractName: 'burner',
        referenceField: 'globalReceiver',
        actual: actualGlobalReceiver,
        expected: this.contracts.accessManager.address,
      };
      this.addViolation(violation);
    }

    const ownableBurner = Ownable__factory.connect(
      burnerRouterAddress,
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

  private async checkRewards(vaultAddress: string): Promise<void> {
    const rewardsAddress = await this.contracts.compoundStakerRewards.rewards();
    const rewards = IDefaultStakerRewards__factory.connect(
      rewardsAddress,
      this.provider,
    );

    const actualVault = await rewards.VAULT();
    if (!eqAddress(actualVault, vaultAddress)) {
      const violation: SymbioticViolation = {
        chain: this.config.chain,
        type: SymbioticViolationType.State,
        contractName: 'rewards',
        referenceField: 'vault',
        actual: actualVault,
        expected: vaultAddress,
      };
      this.addViolation(violation);
    }

    const actualAdminFee = await rewards.adminFee();
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
  }

  private async checkNetwork(): Promise<void> {
    const roleIds = {
      executor: await this.contracts.network.EXECUTOR_ROLE(),
      proposer: await this.contracts.network.PROPOSER_ROLE(),
      canceller: await this.contracts.network.CANCELLER_ROLE(),
      timelockAdmin: await this.contracts.network.TIMELOCK_ADMIN_ROLE(),
    };

    await this.checkAccessControl(
      this.contracts.network.address,
      'network',
      roleIds,
      this.contracts.accessManager.address,
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
