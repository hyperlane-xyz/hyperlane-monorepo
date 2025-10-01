import {
  Address,
  ChainId,
  Domain,
  MultiVM,
  eqAddress,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { MultiVmHookModule } from '../hook/MultiVmHookModule.js';
import { DerivedHookConfig, HookConfig, HookType } from '../hook/types.js';
import { MultiVmIsmModule } from '../ism/MultiVmIsmModule.js';
import { DerivedIsmConfig, IsmConfig, IsmType } from '../ism/types.js';
import { ChainMetadataManager } from '../metadata/ChainMetadataManager.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { MultiVmTransaction } from '../providers/ProviderType.js';
import { ChainName, ChainNameOrId } from '../types.js';

import {
  HyperlaneModule,
  HyperlaneModuleParams,
} from './AbstractHyperlaneModule.js';
import { MultiVmCoreReader } from './MultiVmCoreReader.js';
import {
  CoreConfig,
  CoreConfigSchema,
  DeployedCoreAddresses,
  DerivedCoreConfig,
} from './types.js';

export class MultiVmCoreModule extends HyperlaneModule<
  any,
  CoreConfig,
  Record<string, string>
> {
  protected logger = rootLogger.child({ module: 'MultiVmCoreModule' });
  protected coreReader: MultiVmCoreReader;

  public readonly chainName: ChainName;
  public readonly chainId: ChainId;
  public readonly domainId: Domain;

  constructor(
    protected readonly metadataManager: ChainMetadataManager,
    protected readonly signer: MultiVM.IMultiVMSigner,
    args: HyperlaneModuleParams<CoreConfig, Record<string, string>>,
  ) {
    super(args);

    this.chainName = metadataManager.getChainName(args.chain);
    this.chainId = metadataManager.getChainId(args.chain);
    this.domainId = metadataManager.getDomainId(args.chain);

    this.coreReader = new MultiVmCoreReader(this.metadataManager, signer);
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
   * @returns The created MultiVmCoreModule instance.
   */
  public static async create(params: {
    chain: ChainNameOrId;
    config: CoreConfig;
    multiProvider: MultiProvider;
    signer: MultiVM.IMultiVMSigner;
  }): Promise<MultiVmCoreModule> {
    const { chain, config, multiProvider, signer } = params;
    const addresses = await MultiVmCoreModule.deploy({
      config,
      multiProvider,
      chain,
      signer,
    });

    // Create CoreModule and deploy the Core contracts
    const module = new MultiVmCoreModule(multiProvider, signer, {
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
  static async deploy(params: {
    config: CoreConfig;
    multiProvider: MultiProvider;
    chain: ChainNameOrId;
    signer: MultiVM.IMultiVMSigner;
  }): Promise<DeployedCoreAddresses> {
    const { config, multiProvider, chain, signer } = params;

    const chainName = multiProvider.getChainName(chain);
    const domainId = multiProvider.getDomainId(chain);

    // 1. Deploy default ISM
    const ismModule = await MultiVmIsmModule.create({
      chain: chainName,
      config: config.defaultIsm,
      addresses: {
        mailbox: '',
      },
      multiProvider,
      signer,
    });

    const { deployedIsm: defaultIsm } = ismModule.serialize();

    // 2. Deploy Mailbox with initial configuration
    const mailbox = await signer.createMailbox({
      domain_id: domainId,
      default_ism_id: defaultIsm,
    });

    // 3. Deploy default hook
    const defaultHookModule = await MultiVmHookModule.create({
      chain: chainName,
      config: config.defaultHook,
      addresses: {
        deployedHook: '',
        mailbox: mailbox.mailbox_id,
      },
      multiProvider,
      signer,
    });

    const { deployedHook: defaultHook } = defaultHookModule.serialize();

    // 4. Deploy required hook
    const requiredHookModule = await MultiVmHookModule.create({
      chain: chainName,
      config: config.requiredHook,
      addresses: {
        deployedHook: '',
        mailbox: mailbox.mailbox_id,
      },
      multiProvider,
      signer,
    });

    const { deployedHook: requiredHook } = requiredHookModule.serialize();

    // 5. Update the configuration with the newly created hooks
    await signer.setDefaultIsm({
      mailbox_id: mailbox.mailbox_id,
      ism_id: defaultIsm,
    });
    await signer.setDefaultHook({
      mailbox_id: mailbox.mailbox_id,
      hook_id: defaultHook,
    });
    await signer.setRequiredHook({
      mailbox_id: mailbox.mailbox_id,
      hook_id: requiredHook,
    });

    if (!eqAddress(signer.getSignerAddress(), config.owner)) {
      await signer.setMailboxOwner({
        mailbox_id: mailbox.mailbox_id,
        new_owner: config.owner,
      });
    }

    const validatorAnnounce = await signer.createValidatorAnnounce({
      mailbox_id: mailbox.mailbox_id,
    });

    const addresses: DeployedCoreAddresses = {
      mailbox: mailbox.mailbox_id,
      staticMerkleRootMultisigIsmFactory: '',
      proxyAdmin: '',
      staticMerkleRootWeightedMultisigIsmFactory: '',
      staticAggregationHookFactory: '',
      staticAggregationIsmFactory: '',
      staticMessageIdMultisigIsmFactory: '',
      staticMessageIdWeightedMultisigIsmFactory: '',
      validatorAnnounce: validatorAnnounce.validator_announce_id,
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
  ): Promise<MultiVmTransaction[]> {
    CoreConfigSchema.parse(expectedConfig);
    const actualConfig = await this.read();

    const transactions: MultiVmTransaction[] = [];
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
  ): Promise<MultiVmTransaction[]> {
    if (eqAddress(actualConfig.owner, expectedConfig.owner)) {
      return [];
    }

    return [
      {
        annotation: `Transferring ownership of Mailbox from ${actualConfig.owner} to ${expectedConfig.owner}`,
        transaction: await this.signer.populateSetMailboxOwner({
          signer: this.signer.getSignerAddress(),
          mailbox_id: this.args.addresses.mailbox,
          new_owner: expectedConfig.owner,
        }),
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
  ): Promise<MultiVmTransaction[]> {
    const updateTransactions: MultiVmTransaction[] = [];

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
        transaction: await this.signer.populateSetDefaultIsm({
          signer: this.signer.getSignerAddress(),
          mailbox_id: mailbox,
          ism_id: deployedIsm,
        }),
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
    ismUpdateTxs: MultiVmTransaction[];
  }> {
    const { mailbox } = this.serialize();

    const ismModule = new MultiVmIsmModule(
      this.metadataManager,
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
  ): Promise<MultiVmTransaction[]> {
    const updateTransactions: MultiVmTransaction[] = [];

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
        transaction: await this.signer.populateSetDefaultHook({
          signer: this.signer.getSignerAddress(),
          mailbox_id: mailbox,
          hook_id: deployedHook,
        }),
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
  ): Promise<MultiVmTransaction[]> {
    const updateTransactions: MultiVmTransaction[] = [];

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
        transaction: await this.signer.populateSetRequiredHook({
          signer: this.signer.getSignerAddress(),
          mailbox_id: mailbox,
          hook_id: deployedHook,
        }),
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
    hookUpdateTxs: MultiVmTransaction[];
  }> {
    const { mailbox } = this.serialize();

    const hookModule = new MultiVmHookModule(
      this.metadataManager,
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
