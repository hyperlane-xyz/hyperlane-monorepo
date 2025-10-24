import { AltVM, ProtocolType } from '@hyperlane-xyz/provider-sdk';
import { Address, ChainId, Domain, rootLogger } from '@hyperlane-xyz/utils';

import { AltVMHookModule } from '../hook/AltVMHookModule.js';
import { DerivedHookConfig, HookConfig, HookType } from '../hook/types.js';
import { AltVMIsmModule } from '../ism/AltVMIsmModule.js';
import { DerivedIsmConfig, IsmConfig, IsmType } from '../ism/types.js';
import { ChainMetadataManager } from '../metadata/ChainMetadataManager.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import {
  AnnotatedTypedTransaction,
  ProtocolReceipt,
} from '../providers/ProviderType.js';
import { ChainName, ChainNameOrId } from '../types.js';

import {
  HyperlaneModule,
  HyperlaneModuleParams,
} from './AbstractHyperlaneModule.js';
import { AltVMCoreReader } from './AltVMCoreReader.js';
import {
  CoreConfig,
  CoreConfigSchema,
  DeployedCoreAddresses,
  DerivedCoreConfig,
} from './types.js';

export class AltVMCoreModule<PT extends ProtocolType> extends HyperlaneModule<
  any,
  CoreConfig,
  Record<string, string>
> {
  protected logger = rootLogger.child({ module: 'AltVMCoreModule' });
  protected coreReader: AltVMCoreReader;

  public readonly chainName: ChainName;
  public readonly chainId: ChainId;
  public readonly domainId: Domain;

  constructor(
    protected readonly metadataManager: ChainMetadataManager,
    protected readonly signer: AltVM.ISigner<
      AnnotatedTypedTransaction<PT>,
      ProtocolReceipt<PT>
    >,
    args: HyperlaneModuleParams<CoreConfig, Record<string, string>>,
  ) {
    super(args);

    this.chainName = metadataManager.getChainName(args.chain);
    this.chainId = metadataManager.getChainId(args.chain);
    this.domainId = metadataManager.getDomainId(args.chain);

    this.coreReader = new AltVMCoreReader(this.metadataManager, signer);
  }

  /**
   * Reads the core configuration from the mailbox address
   * @returns The core config.
   */
  public async read(): Promise<DerivedCoreConfig> {
    return this.coreReader.deriveCoreConfig(this.args.addresses.mailbox);
  }

  /**
   * Deploys the Core contracts.
   * @returns The created AltVMCoreModule instance.
   */
  public static async create<PT extends ProtocolType>(params: {
    chain: ChainNameOrId;
    config: CoreConfig;
    multiProvider: MultiProvider;
    signer: AltVM.ISigner<AnnotatedTypedTransaction<PT>, ProtocolReceipt<PT>>;
  }): Promise<AltVMCoreModule<PT>> {
    const { chain, config, multiProvider, signer } = params;
    const addresses = await AltVMCoreModule.deploy<PT>({
      config,
      multiProvider,
      chain,
      signer,
    });

    // Create CoreModule and deploy the Core contracts
    const module = new AltVMCoreModule<PT>(multiProvider, signer, {
      addresses,
      chain,
      config,
    });

    return module;
  }

  /**
   * Deploys the core Hyperlane contracts.
   * @returns The deployed core contract addresses.
   */
  static async deploy<PT extends ProtocolType>(params: {
    config: CoreConfig;
    multiProvider: MultiProvider;
    chain: ChainNameOrId;
    signer: AltVM.ISigner<AnnotatedTypedTransaction<PT>, ProtocolReceipt<PT>>;
  }): Promise<DeployedCoreAddresses> {
    const { config, multiProvider, chain, signer } = params;

    const chainName = multiProvider.getChainName(chain);
    const domainId = multiProvider.getDomainId(chain);

    // 1. Deploy default ISM
    const ismModule = await AltVMIsmModule.create({
      chain: chainName,
      config: config.defaultIsm,
      addresses: {
        mailbox: '',
      },
      getChainMetadata: (chain) => multiProvider.getChainMetadata(chain),
      getChainName: (domainId) => multiProvider.tryGetChainName(domainId),
      getDomainId: (chain) => multiProvider.tryGetDomainId(chain),
      getKnownChainNames: () => multiProvider.getKnownChainNames(),
      signer,
    });

    const { deployedIsm: defaultIsm } = ismModule.serialize();

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
      getChainMetadata: (chain) => multiProvider.getChainMetadata(chain),
      getDomainId: (chain) => multiProvider.tryGetDomainId(chain),
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
      getChainMetadata: (chain) => multiProvider.getChainMetadata(chain),
      getDomainId: (chain) => multiProvider.tryGetDomainId(chain),
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
        case IsmType.MERKLE_ROOT_MULTISIG: {
          addresses.staticMerkleRootMultisigIsmFactory = defaultIsm;
          break;
        }
        case IsmType.MESSAGE_ID_MULTISIG: {
          addresses.staticMessageIdMultisigIsmFactory = defaultIsm;
          break;
        }
        case IsmType.ROUTING: {
          addresses.domainRoutingIsmFactory = defaultIsm;
          break;
        }
      }
    }

    if (config.defaultHook && typeof config.defaultHook !== 'string') {
      switch (config.defaultHook.type) {
        case HookType.INTERCHAIN_GAS_PAYMASTER: {
          addresses.interchainGasPaymaster = defaultHook;
          break;
        }
        case HookType.MERKLE_TREE: {
          addresses.merkleTreeHook = defaultHook;
          break;
        }
      }
    }

    if (config.requiredHook && typeof config.requiredHook !== 'string') {
      switch (config.requiredHook.type) {
        case HookType.INTERCHAIN_GAS_PAYMASTER: {
          addresses.interchainGasPaymaster = requiredHook;
          break;
        }
        case HookType.MERKLE_TREE: {
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
  public async update(
    expectedConfig: CoreConfig,
  ): Promise<AnnotatedTypedTransaction<PT>[]> {
    CoreConfigSchema.parse(expectedConfig);
    const actualConfig = await this.read();

    const transactions: AnnotatedTypedTransaction<PT>[] = [];
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
  ): Promise<AnnotatedTypedTransaction<PT>[]> {
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
  ): Promise<AnnotatedTypedTransaction<PT>[]> {
    const updateTransactions: AnnotatedTypedTransaction<PT>[] = [];

    const actualDefaultIsmConfig = actualConfig.defaultIsm as DerivedIsmConfig;

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
    expectDefaultIsmConfig: IsmConfig,
  ): Promise<{
    deployedIsm: Address;
    ismUpdateTxs: AnnotatedTypedTransaction<PT>[];
  }> {
    const { mailbox } = this.serialize();

    const ismModule = new AltVMIsmModule(
      (chain) => this.metadataManager.getChainMetadata(chain),
      (chain) => this.metadataManager.tryGetChainName(chain),
      (chain) => this.metadataManager.tryGetDomainId(chain),
      () => this.metadataManager.getKnownChainNames(),
      {
        addresses: {
          mailbox: mailbox,
          deployedIsm: actualDefaultIsmConfig.address,
        },
        chain: this.chainName,
        config: actualDefaultIsmConfig.address,
      },
      this.signer,
    );
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
  ): Promise<AnnotatedTypedTransaction<PT>[]> {
    const updateTransactions: AnnotatedTypedTransaction<PT>[] = [];

    const actualDefaultHookConfig =
      actualConfig.defaultHook as DerivedHookConfig;

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
  ): Promise<AnnotatedTypedTransaction<PT>[]> {
    const updateTransactions: AnnotatedTypedTransaction<PT>[] = [];

    const actualRequiredHookConfig =
      actualConfig.requiredHook as DerivedHookConfig;

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
    expectHookConfig: HookConfig,
  ): Promise<{
    deployedHook: Address;
    hookUpdateTxs: AnnotatedTypedTransaction<PT>[];
  }> {
    const { mailbox } = this.serialize();

    const hookModule = new AltVMHookModule(
      (chain) => this.metadataManager.getChainMetadata(chain),
      (chain) => this.metadataManager.tryGetDomainId(chain),
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
