import { AltVM, ProtocolType } from '@hyperlane-xyz/provider-sdk';
import { Address, Domain, rootLogger } from '@hyperlane-xyz/utils';

import { ChainLookup } from '../altvm.js';
import { AltVMHookModule } from '../hook/AltVMHookModule.js';
import { DerivedHookConfig, HookConfig, HookType } from '../hook/types.js';
import { AltVMIsmModule } from '../ism/AltVMIsmModule.js';
import { DerivedIsmConfig, IsmConfig, IsmType } from '../ism/types.js';
import {
  AnnotatedTypedTransaction,
  ProtocolReceipt,
} from '../providers/ProviderType.js';
import { ChainName, ChainNameOrId } from '../types.js';

import { AltVMCoreReader } from './AltVMCoreReader.js';
import {
  CoreConfig,
  CoreConfigSchema,
  DeployedCoreAddresses,
  DerivedCoreConfig,
} from './types.js';

/**
 * Minimal chain metadata needed for AltVM Core operations
 */
export interface ChainMetadataForCore {
  name: string;
  domainId: Domain;
  nativeToken?: {
    decimals?: number;
    denom?: string;
  };
  blocks?: {
    confirmations?: number;
    estimateBlockTime?: number;
  };
}

/**
 * Function adapters for chain metadata lookups required by AltVM Core operations
 */
export type ChainMetadataLookup = (
  chain: ChainNameOrId,
) => ChainMetadataForCore;
export type ChainNameLookup = (domainId: Domain) => string | null;
export type DomainIdLookup = (chain: ChainNameOrId) => Domain | null;
export type GetKnownChainNames = () => string[];

export class AltVMCoreModule<PT extends ProtocolType> extends HyperlaneModule<
  any,
  CoreConfig,
  Record<string, string>
> {
  protected logger = rootLogger.child({ module: 'AltVMCoreModule' });
  protected coreReader: AltVMCoreReader;

  // Cached chain name
  public readonly chainName: ChainName;

  constructor(
    protected readonly getChainMetadata: ChainMetadataLookup,
    protected readonly getChainName: ChainNameLookup,
    protected readonly getDomainId: DomainIdLookup,
    protected readonly getKnownChainNames: GetKnownChainNames,
    protected readonly signer: AltVM.ISigner<
      AnnotatedTypedTransaction<PT>,
      ProtocolReceipt<PT>
    >,
    args: HyperlaneModuleParams<CoreConfig, Record<string, string>>,
  ) {
    const metadata = chainLookup.getChainMetadata(args.chain);
    this.chainName = metadata.name;

    const metadata = getChainMetadata(args.chain);
    this.chainName = metadata.name;

    this.coreReader = new AltVMCoreReader(
      getChainMetadata,
      getChainName,
      signer,
    );
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
    getChainMetadata: ChainMetadataLookup;
    getChainName: ChainNameLookup;
    getDomainId: DomainIdLookup;
    getKnownChainNames: GetKnownChainNames;
    signer: AltVM.ISigner<AnnotatedTypedTransaction<PT>, ProtocolReceipt<PT>>;
  }): Promise<AltVMCoreModule<PT>> {
    const addresses = await AltVMCoreModule.deploy<PT>(params);

    return new AltVMCoreModule<PT>(
      params.getChainMetadata,
      params.getChainName,
      params.getDomainId,
      params.getKnownChainNames,
      params.signer,
      {
        addresses,
        chain: params.chain,
        config: params.config,
      },
    );
  }

  /**
   * Deploys the core Hyperlane contracts.
   * @returns The deployed core contract addresses.
   */
  static async deploy(params: {
    config: CoreConfig;
    getChainMetadata: ChainMetadataLookup;
    getChainName: ChainNameLookup;
    getDomainId: DomainIdLookup;
    getKnownChainNames: GetKnownChainNames;
    chain: ChainNameOrId;
    signer: AltVM.ISigner<AnnotatedTypedTransaction<PT>, ProtocolReceipt<PT>>;
  }): Promise<DeployedCoreAddresses> {
    const {
      config,
      getChainMetadata,
      getChainName,
      getDomainId,
      getKnownChainNames,
      chain,
      signer,
    } = params;

    const metadata = getChainMetadata(chain);
    const chainName = metadata.name;
    const domainId = metadata.domainId;

    // 1. Deploy default ISM
    const ismModule = await AltVMIsmModule.create({
      chain: chainName,
      config: config.defaultIsm,
      addresses: {
        mailbox: '',
      },
      getChainMetadata,
      getChainName,
      getDomainId,
      getKnownChainNames,
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
      getChainMetadata,
      getDomainId,
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
      getChainMetadata,
      getDomainId,
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
  public async update(expectedConfig: CoreConfig): Promise<AnnotatedTx[]> {
    CoreConfigSchema.parse(expectedConfig);
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
    ismUpdateTxs: AnnotatedTx[];
  }> {
    const { mailbox } = this.serialize();

    const ismModule = new AltVMIsmModule(
      this.getChainMetadata,
      this.getChainName,
      this.getDomainId,
      this.getKnownChainNames,
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
  ): Promise<AnnotatedTx[]> {
    const updateTransactions: AnnotatedTx[] = [];

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
  ): Promise<AnnotatedTx[]> {
    const updateTransactions: AnnotatedTx[] = [];

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
    hookUpdateTxs: AnnotatedTx[];
  }> {
    const { mailbox } = this.serialize();

    const hookModule = new AltVMHookModule(
      this.getChainMetadata,
      this.getDomainId,
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
