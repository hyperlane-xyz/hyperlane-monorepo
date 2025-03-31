import {
  IBaseSlasher,
  IBaseSlasher__factory,
  IBurnerRouter,
  IBurnerRouter__factory,
  IDefaultStakerRewards,
  IDefaultStakerRewards__factory,
  INetworkRestakeDelegator,
  INetworkRestakeDelegator__factory,
  IVaultTokenized,
  IVaultTokenized__factory,
  TimelockController,
  TimelockController__factory,
} from '@hyperlane-xyz/core';
import {
  CheckerViolation,
  MultiProvider,
  ViolationType,
} from '@hyperlane-xyz/sdk';
import { eqAddress, rootLogger } from '@hyperlane-xyz/utils';

enum SymbioticViolationType {
  State = 'State',
}

interface SymbioticViolation extends CheckerViolation {
  type: SymbioticViolationType | ViolationType;
  contractName: string;
  referenceField: string;
}

interface SymbioticConfig {
  chain: string;
  // network: {
  //   address: string;
  // };
  accessManager: {
    address: string;
  };
  collateral: {
    address: string;
  };
  vault: {
    address: string;
    epochDuration?: number;
  };
  slasher: {
    address: string;
  };
  delegator: {
    address: string;
    networkLimit?: any;
    operatorNetworkShares?: any;
  };
  burner: {
    address: string;
  };
  // rewards: {
  //   address: string;
  //   adminFee?: any;
  // };
}

export class SymbioticChecker {
  readonly violations: CheckerViolation[] = [];

  constructor(
    readonly multiProvider: MultiProvider,
    readonly config: SymbioticConfig,
  ) {}

  async check(): Promise<void> {
    const provider = this.multiProvider.getProvider(this.config.chain);

    const vault = IVaultTokenized__factory.connect(
      this.config.vault.address,
      provider,
    );
    const delegator = INetworkRestakeDelegator__factory.connect(
      this.config.delegator.address,
      provider,
    );
    const slasher = IBaseSlasher__factory.connect(
      this.config.slasher.address,
      provider,
    );
    const burnerRouter = IBurnerRouter__factory.connect(
      this.config.burner.address,
      provider,
    );
    // const rewards = IDefaultStakerRewards__factory.connect(
    //   this.config.rewards.address,
    //   provider,
    // );

    // const network = TimelockController__factory.connect(
    //   this.config.network.address,
    //   provider,
    // );

    await this.checkVault(vault);
    await this.checkDelegator(delegator);
    await this.checkSlasher(slasher);
    await this.checkBurner(burnerRouter);
    // await this.checkRewards(rewards);
    // await this.checkNetwork(network);
  }

  private async checkVault(vault: IVaultTokenized): Promise<void> {
    const actualCollateral = await vault.collateral();
    if (!eqAddress(actualCollateral, this.config.collateral.address)) {
      this.addViolation({
        chain: this.config.chain,
        type: SymbioticViolationType.State,
        contractName: 'vault',
        referenceField: 'collateral',
        actual: actualCollateral,
        expected: this.config.collateral.address,
      });
    }

    const actualSlasher = await vault.slasher();
    if (!eqAddress(actualSlasher, this.config.slasher.address)) {
      this.addViolation({
        chain: this.config.chain,
        type: SymbioticViolationType.State,
        contractName: 'vault',
        referenceField: 'slasher',
        actual: actualSlasher,
        expected: this.config.slasher.address,
      });
    }

    const actualDelegator = await vault.delegator();
    if (!eqAddress(actualDelegator, this.config.delegator.address)) {
      this.addViolation({
        chain: this.config.chain,
        type: SymbioticViolationType.State,
        contractName: 'vault',
        referenceField: 'delegator',
        actual: actualDelegator,
        expected: this.config.delegator.address,
      });
    }

    const actualBurner = await vault.burner();
    if (!eqAddress(actualBurner, this.config.burner.address)) {
      this.addViolation({
        chain: this.config.chain,
        type: SymbioticViolationType.State,
        contractName: 'vault',
        referenceField: 'burner',
        actual: actualBurner,
        expected: this.config.burner.address,
      });
    }

    const actualEpochDuration = await vault.epochDuration();
    if (actualEpochDuration !== this.config.vault.epochDuration) {
      this.addViolation({
        chain: this.config.chain,
        type: SymbioticViolationType.State,
        contractName: 'vault',
        referenceField: 'epochDuration',
        actual: actualEpochDuration,
        expected: this.config.vault.epochDuration,
      });
    }

    // TODO add AccessControl checks
    //   `hasRole(bytes32 role, address account)` -
    //     `DEPOSIT_WHITELIST_SET_ROLE()` -
    //     `DEPOSITOR_WHITELIST_ROLE()` -
    //     `IS_DEPOSIT_LIMIT_SET_ROLE()` -
    //     `DEPOSIT_LIMIT_SET_ROLE()`;
  }

  private async checkDelegator(
    delegator: INetworkRestakeDelegator,
  ): Promise<void> {
    const actualVault = await delegator.vault();
    if (!eqAddress(actualVault, this.config.vault.address)) {
      this.addViolation({
        chain: this.config.chain,
        type: SymbioticViolationType.State,
        contractName: 'delegator',
        referenceField: 'vault',
        actual: actualVault,
        expected: this.config.vault.address,
      });
    }

    // TODO subnetwork checks

    // TODO add AccessControl checks
    // `hasRole(bytes32 role, address acount)` -
    //   `NETWORK_LIMIT_SET_ROLE()` -
    //   `OPERATOR_NETWORK_SHARES_SET_ROLE()`;
  }

  private async checkSlasher(slasher: IBaseSlasher): Promise<void> {
    const actualVault = await slasher.vault();
    if (!eqAddress(actualVault, this.config.vault.address)) {
      this.addViolation({
        chain: this.config.chain,
        type: SymbioticViolationType.State,
        contractName: 'slasher',
        referenceField: 'vault',
        actual: actualVault,
        expected: this.config.vault.address,
      });
    }

    const isBurnerHook = await slasher.isBurnerHook();
    if (!isBurnerHook) {
      this.addViolation({
        chain: this.config.chain,
        type: SymbioticViolationType.State,
        contractName: 'slasher',
        referenceField: 'isBurnerHook',
        actual: false,
        expected: true,
      });
    }
  }

  private async checkBurner(burnerRouter: IBurnerRouter): Promise<void> {
    // TODO
    // `collateral()` done
    // `networkReceiver(address network)` done
    // `owner()`

    const actualCollateral = await burnerRouter.collateral();
    if (!eqAddress(actualCollateral, this.config.collateral.address)) {
      this.addViolation({
        chain: this.config.chain,
        type: SymbioticViolationType.State,
        contractName: 'burner',
        referenceField: 'collateral',
        actual: actualCollateral,
        expected: this.config.collateral.address,
      });
    }

    // const actualNetworkReceiver = await burnerRouter.networkReceiver(
    //   this.config.network.address,
    // );
    // if (!eqAddress(actualNetworkReceiver, this.config.slasher.address)) {
    //   this.addViolation({
    //     chain: this.config.chain,
    //     type: SymbioticViolationType.State,
    //     contractName: 'burner',
    //     referenceField: 'networkReceiver',
    //     actual: actualNetworkReceiver,
    //     expected: this.config.slasher.address,
    //   });
    // }
  }

  // private async checkRewards(rewards: IDefaultStakerRewards): Promise<void> {
  //   const actualVault = await rewards.VAULT();
  //   if (!eqAddress(actualVault, this.config.vault.address)) {
  //     this.addViolation({
  //       chain: this.config.chain,
  //       type: SymbioticViolationType.State,
  //       contractName: 'rewards',
  //       referenceField: 'vault',
  //       actual: actualVault,
  //       expected: this.config.vault.address,
  //     });
  //   }

  //   const actualAdminFee = await rewards.adminFee();
  //   console.log('actualAdminFee', actualAdminFee);
  //   if (actualAdminFee !== this.config.rewards.adminFee) {
  //     this.addViolation({
  //       chain: this.config.chain,
  //       type: SymbioticViolationType.State,
  //       contractName: 'rewards',
  //       referenceField: 'adminFee',
  //       actual: actualAdminFee,
  //       expected: this.config.rewards.adminFee,
  //     });
  //   }

  //   // TODO
  //   // `hasRole(bytes32 role, address acount)` -
  //   //   `ADMIN_FEE_CLAIM_ROLE()` -
  //   //   `ADMIN_FEE_SET_ROLE()`;
  // }

  // private async checkNetwork(network: TimelockController): Promise<void> {
  //   const roleIds = {
  //     executor: await network.EXECUTOR_ROLE(),
  //     proposer: await network.PROPOSER_ROLE(),
  //     canceller: await network.CANCELLER_ROLE(),
  //     admin: await network.TIMELOCK_ADMIN_ROLE(),
  //   };

  //   type RoleKey = keyof typeof roleIds;

  //   // TODO: Define expected roles in config
  //   const expectedRoles: Record<RoleKey, string> = {
  //     executor: this.config.accessManager.address,
  //     proposer: this.config.accessManager.address,
  //     canceller: this.config.accessManager.address,
  //     admin: this.config.accessManager.address,
  //   };

  //   for (const [role, account] of Object.entries(expectedRoles)) {
  //     const hasRole = await network.hasRole(roleIds[role as RoleKey], account);
  //     if (!hasRole) {
  //       this.addViolation({
  //         chain: this.config.chain,
  //         type: SymbioticViolationType.State,
  //         contractName: 'network',
  //         referenceField: `hasRole(${role})`,
  //         actual: false,
  //         expected: true,
  //       });
  //     }
  //   }
  // }

  private addViolation(violation: SymbioticViolation): void {
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
        'contractName',
        'referenceField',
        'actual',
        'expected',
      ]);
    } else {
      console.info('Symbiotic Checker found no violations');
    }
  }
}
