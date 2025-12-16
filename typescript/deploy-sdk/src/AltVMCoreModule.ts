import { AltVM } from '@hyperlane-xyz/provider-sdk';
import { ChainLookup } from '@hyperlane-xyz/provider-sdk/chain';
import {
  CoreConfig,
  CoreModuleType,
  DeployedCoreAddresses,
  DerivedCoreConfig,
} from '@hyperlane-xyz/provider-sdk/core';
import {
  DerivedHookConfig,
  HookConfig,
} from '@hyperlane-xyz/provider-sdk/hook';
import { DerivedIsmConfig, IsmConfig } from '@hyperlane-xyz/provider-sdk/ism';
import {
  AnnotatedTx,
  HypModule,
  HypModuleArgs,
  TxReceipt,
} from '@hyperlane-xyz/provider-sdk/module';
import { Address, Logger, rootLogger } from '@hyperlane-xyz/utils';

import { AltVMCoreReader } from './AltVMCoreReader.js';
import { AltVMHookModule } from './AltVMHookModule.js';
import { ismModuleProvider } from './ism-module.js';
import { validateIsmConfig } from './utils/validation.js';

export class AltVMCoreModule implements HypModule<CoreModuleType> {
  protected logger: Logger = rootLogger.child({ module: 'AltVMCoreModule' });
  protected coreReader: AltVMCoreReader;

  // Cached chain name
  public readonly chainName: string;

  constructor(
    protected readonly chainLookup: ChainLookup,
    protected readonly signer: AltVM.ISigner<AnnotatedTx, TxReceipt>,
    private readonly args: HypModuleArgs<CoreModuleType>,
  ) {
    const metadata = chainLookup.getChainMetadata(args.chain);
    this.chainName = metadata.name;

    this.coreReader = new AltVMCoreReader(metadata, chainLookup, signer);
  }

  /**
   * Reads the core configuration from the mailbox address
   * @returns The core config.
   */
  public async read(): Promise<DerivedCoreConfig> {
    return this.coreReader.deriveCoreConfig(this.args.addresses.mailbox);
  }

  public serialize(): DeployedCoreAddresses {
    return this.args.addresses;
  }

  /**
   * Deploys the Core contracts.
   * @returns The created AltVMCoreModule instance.
   */
  public static async create(params: {
    chain: string;
    config: CoreConfig;
    chainLookup: ChainLookup;
    signer: AltVM.ISigner<AnnotatedTx, TxReceipt>;
  }): Promise<AltVMCoreModule> {
    const addresses = await AltVMCoreModule.deploy(params);

    return new AltVMCoreModule(params.chainLookup, params.signer, {
      addresses,
      chain: params.chain,
      config: params.config,
    });
  }

  /**
   * Deploys the core Hyperlane contracts.
   * @returns The deployed core contract addresses.
   */
  static async deploy(params: {
    config: CoreConfig;
    chainLookup: ChainLookup;
    chain: string;
    signer: AltVM.ISigner<AnnotatedTx, TxReceipt>;
  }): Promise<DeployedCoreAddresses> {
    const { config, chainLookup, chain, signer } = params;

    const metadata = chainLookup.getChainMetadata(chain);
    const chainName = metadata.name;
    const domainId = metadata.domainId;

    // Validate ISM configuration before deployment
    validateIsmConfig(config.defaultIsm, chainName, 'core default ISM');

    // 1. Deploy default ISM using module provider
    let defaultIsm: string;
    if (typeof config.defaultIsm === 'string') {
      // Address reference - use existing ISM
      defaultIsm = config.defaultIsm;
    } else {
      // Deploy new ISM
      const moduleProvider = ismModuleProvider(chainLookup, metadata, '');
      const ismModule = await moduleProvider.createModule(
        signer,
        config.defaultIsm,
      );
      defaultIsm = ismModule.serialize().deployedIsm;
    }

    // 2. Deploy Mailbox with initial configuration
    const mailbox = await signer.createMailbox({
      domainId: domainId,
      defaultIsmAddress: defaultIsm,
    });

    // 3. Deploy default hook
    const defaultHookModule = await AltVMHookModule.create({
      chain: chainName,
      config: config.defaultHook,
      addresses: {
        deployedHook: '',
        mailbox: mailbox.mailboxAddress,
      },
      chainLookup,
      signer,
    });

    const { deployedHook: defaultHook } = defaultHookModule.serialize();

    // 4. Deploy required hook
    const requiredHookModule = await AltVMHookModule.create({
      chain: chainName,
      config: config.requiredHook,
      addresses: {
        deployedHook: '',
        mailbox: mailbox.mailboxAddress,
      },
      chainLookup,
      signer,
    });

    const { deployedHook: requiredHook } = requiredHookModule.serialize();

    // 5. Update the configuration with the newly created hooks
    await signer.setDefaultIsm({
      mailboxAddress: mailbox.mailboxAddress,
      ismAddress: defaultIsm,
    });
    await signer.setDefaultHook({
      mailboxAddress: mailbox.mailboxAddress,
      hookAddress: defaultHook,
    });
    await signer.setRequiredHook({
      mailboxAddress: mailbox.mailboxAddress,
      hookAddress: requiredHook,
    });

    if (signer.getSignerAddress() !== config.owner) {
      await signer.setMailboxOwner({
        mailboxAddress: mailbox.mailboxAddress,
        newOwner: config.owner,
      });
    }

    const validatorAnnounce = await signer.createValidatorAnnounce({
      mailboxAddress: mailbox.mailboxAddress,
    });

    const addresses: DeployedCoreAddresses = {
      mailbox: mailbox.mailboxAddress,
      staticMerkleRootMultisigIsmFactory: '',
      proxyAdmin: '',
      staticMerkleRootWeightedMultisigIsmFactory: '',
      staticAggregationHookFactory: '',
      staticAggregationIsmFactory: '',
      staticMessageIdMultisigIsmFactory: '',
      staticMessageIdWeightedMultisigIsmFactory: '',
      validatorAnnounce: validatorAnnounce.validatorAnnounceId,
      testRecipient: '',
      interchainAccountRouter: '',
      domainRoutingIsmFactory: '',
    };

    if (config.defaultIsm && typeof config.defaultIsm !== 'string') {
      switch (config.defaultIsm.type) {
        case 'merkleRootMultisigIsm': {
          addresses.staticMerkleRootMultisigIsmFactory = defaultIsm;
          break;
        }
        case 'messageIdMultisigIsm': {
          addresses.staticMessageIdMultisigIsmFactory = defaultIsm;
          break;
        }
        case 'domainRoutingIsm': {
          addresses.domainRoutingIsmFactory = defaultIsm;
          break;
        }
      }
    }

    if (config.defaultHook && typeof config.defaultHook !== 'string') {
      switch (config.defaultHook.type) {
        case 'interchainGasPaymaster': {
          addresses.interchainGasPaymaster = defaultHook;
          break;
        }
        case 'merkleTreeHook': {
          addresses.merkleTreeHook = defaultHook;
          break;
        }
      }
    }

    if (config.requiredHook && typeof config.requiredHook !== 'string') {
      switch (config.requiredHook.type) {
        case 'interchainGasPaymaster': {
          addresses.interchainGasPaymaster = requiredHook;
          break;
        }
        case 'merkleTreeHook': {
          addresses.merkleTreeHook = requiredHook;
          break;
        }
      }
    }

    return addresses;
  }

  /**
   * Updates the core contracts with the provided configuration.
   *
   * @param expectedConfig - The configuration for the core contracts to be updated.
   * @returns An array of transactions that were executed to update the contract.
   */
  public async update(expectedConfig: CoreConfig): Promise<AnnotatedTx[]> {
    const actualConfig = await this.read();

    const transactions: AnnotatedTx[] = [];
    transactions.push(
      ...(await this.createDefaultIsmUpdateTxs(actualConfig, expectedConfig)),
      ...(await this.createDefaultHookUpdateTxs(actualConfig, expectedConfig)),
      ...(await this.createRequiredHookUpdateTxs(actualConfig, expectedConfig)),
      ...(await this.createMailboxOwnerUpdateTxs(actualConfig, expectedConfig)),
    );

    return transactions;
  }

  private async createMailboxOwnerUpdateTxs(
    actualConfig: CoreConfig,
    expectedConfig: CoreConfig,
  ): Promise<AnnotatedTx[]> {
    if (actualConfig.owner === expectedConfig.owner) {
      return [];
    }

    return [
      {
        annotation: `Transferring ownership of Mailbox from ${actualConfig.owner} to ${expectedConfig.owner}`,
        ...(await this.signer.getSetMailboxOwnerTransaction({
          signer: actualConfig.owner,
          mailboxAddress: this.args.addresses.mailbox,
          newOwner: expectedConfig.owner,
        })),
      },
    ];
  }

  /**
   * Create a transaction to update an existing ISM config, or deploy a new ISM and return a tx to setDefaultIsm
   *
   * @param actualConfig - The on-chain router configuration, including the ISM configuration, and address.
   * @param expectedConfig - The expected token router configuration, including the ISM configuration.
   * @returns Transaction that need to be executed to update the ISM configuration.
   */
  async createDefaultIsmUpdateTxs(
    actualConfig: DerivedCoreConfig,
    expectedConfig: CoreConfig,
  ): Promise<AnnotatedTx[]> {
    const updateTransactions: AnnotatedTx[] = [];

    const actualDefaultIsmConfig = actualConfig.defaultIsm;

    // Try to update (may also deploy) Ism with the expected config
    const { deployedIsm, ismUpdateTxs } = await this.deployOrUpdateIsm(
      actualDefaultIsmConfig,
      expectedConfig.defaultIsm,
    );

    if (ismUpdateTxs.length) {
      updateTransactions.push(...ismUpdateTxs);
    }

    const newIsmDeployed = actualDefaultIsmConfig.address !== deployedIsm;
    if (newIsmDeployed) {
      const { mailbox } = this.serialize();
      updateTransactions.push({
        annotation: `Updating default ISM of Mailbox from ${actualDefaultIsmConfig.address} to ${deployedIsm}`,
        ...(await this.signer.getSetDefaultIsmTransaction({
          signer: actualConfig.owner,
          mailboxAddress: mailbox,
          ismAddress: deployedIsm,
        })),
      });
    }

    return updateTransactions;
  }

  /**
   * Updates or deploys the ISM using the provided configuration.
   *
   * @returns Object with deployedIsm address, and update Transactions
   */
  public async deployOrUpdateIsm(
    actualDefaultIsmConfig: DerivedIsmConfig,
    expectDefaultIsmConfig: IsmConfig | string,
  ): Promise<{
    deployedIsm: Address;
    ismUpdateTxs: AnnotatedTx[];
  }> {
    // If expected ISM is an address reference, use it directly
    if (typeof expectDefaultIsmConfig === 'string') {
      return {
        deployedIsm: expectDefaultIsmConfig,
        ismUpdateTxs: [],
      };
    }

    const { mailbox } = this.serialize();
    const chainMetadata = this.chainLookup.getChainMetadata(this.args.chain);

    const moduleProvider = ismModuleProvider(
      this.chainLookup,
      chainMetadata,
      mailbox,
    );
    const ismModule = moduleProvider.connectModule(this.signer, {
      addresses: {
        mailbox: mailbox,
        deployedIsm: actualDefaultIsmConfig.address,
      },
      chain: this.chainName,
      config: actualDefaultIsmConfig.address,
    });
    this.logger.info(
      `Comparing target ISM config with ${this.args.chain} chain`,
    );
    const ismUpdateTxs = await ismModule.update(expectDefaultIsmConfig);
    const { deployedIsm } = ismModule.serialize();

    return { deployedIsm, ismUpdateTxs };
  }

  /**
   * Create a transaction to update an existing Hook config, or deploy a new Hook and return a tx to setDefaultHook
   *
   * @param actualConfig - The on-chain router configuration, including the Hook configuration, and address.
   * @param expectedConfig - The expected token router configuration, including the Hook configuration.
   * @returns Transaction that need to be executed to update the Hook configuration.
   */
  async createDefaultHookUpdateTxs(
    actualConfig: DerivedCoreConfig,
    expectedConfig: CoreConfig,
  ): Promise<AnnotatedTx[]> {
    const updateTransactions: AnnotatedTx[] = [];

    const actualDefaultHookConfig = actualConfig.defaultHook;

    // Try to update (may also deploy) Hook with the expected config
    const { deployedHook, hookUpdateTxs } = await this.deployOrUpdateHook(
      actualDefaultHookConfig,
      expectedConfig.defaultHook,
    );

    if (hookUpdateTxs.length) {
      updateTransactions.push(...hookUpdateTxs);
    }

    const newHookDeployed = actualDefaultHookConfig.address !== deployedHook;
    if (newHookDeployed) {
      const { mailbox } = this.serialize();
      updateTransactions.push({
        annotation: `Updating default Hook of Mailbox from ${actualDefaultHookConfig.address} to ${deployedHook}`,
        ...(await this.signer.getSetDefaultHookTransaction({
          signer: actualConfig.owner,
          mailboxAddress: mailbox,
          hookAddress: deployedHook,
        })),
      });
    }

    return updateTransactions;
  }

  /**
   * Create a transaction to update an existing Hook config, or deploy a new Hook and return a tx to setRequiredHook
   *
   * @param actualConfig - The on-chain router configuration, including the Hook configuration, and address.
   * @param expectedConfig - The expected token router configuration, including the Hook configuration.
   * @returns Transaction that need to be executed to update the Hook configuration.
   */
  async createRequiredHookUpdateTxs(
    actualConfig: DerivedCoreConfig,
    expectedConfig: CoreConfig,
  ): Promise<AnnotatedTx[]> {
    const updateTransactions: AnnotatedTx[] = [];

    const actualRequiredHookConfig = actualConfig.requiredHook;

    // Try to update (may also deploy) Hook with the expected config
    const { deployedHook, hookUpdateTxs } = await this.deployOrUpdateHook(
      actualRequiredHookConfig,
      expectedConfig.requiredHook,
    );

    if (hookUpdateTxs.length) {
      updateTransactions.push(...hookUpdateTxs);
    }

    const newHookDeployed = actualRequiredHookConfig.address !== deployedHook;
    if (newHookDeployed) {
      const { mailbox } = this.serialize();
      updateTransactions.push({
        annotation: `Updating required Hook of Mailbox from ${actualRequiredHookConfig.address} to ${deployedHook}`,
        ...(await this.signer.getSetRequiredHookTransaction({
          signer: actualConfig.owner,
          mailboxAddress: mailbox,
          hookAddress: deployedHook,
        })),
      });
    }

    return updateTransactions;
  }

  /**
   * Updates or deploys the Hook using the provided configuration.
   *
   * @returns Object with deployedHook address, and update Transactions
   */
  public async deployOrUpdateHook(
    actualHookConfig: DerivedHookConfig,
    expectHookConfig: HookConfig | string,
  ): Promise<{
    deployedHook: Address;
    hookUpdateTxs: AnnotatedTx[];
  }> {
    const { mailbox } = this.serialize();

    const hookModule = new AltVMHookModule(
      this.chainLookup,
      {
        addresses: {
          mailbox: mailbox,
          deployedHook: actualHookConfig.address,
        },
        chain: this.chainName,
        config: actualHookConfig.address,
      },
      this.signer,
    );
    this.logger.info(
      `Comparing target Hook config with ${this.args.chain} chain`,
    );
    const hookUpdateTxs = await hookModule.update(expectHookConfig);
    const { deployedHook } = hookModule.serialize();

    return { deployedHook, hookUpdateTxs };
  }
}
