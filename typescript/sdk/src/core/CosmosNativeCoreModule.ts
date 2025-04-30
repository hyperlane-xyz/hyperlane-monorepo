import {
  COSMOS_MODULE_MESSAGE_REGISTRY as R,
  SigningHyperlaneModuleClient,
} from '@hyperlane-xyz/cosmos-sdk';
import { DeployedCoreAddresses } from '@hyperlane-xyz/sdk';
import {
  Address,
  Domain,
  ProtocolType,
  eqAddress,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { CosmosNativeDeployer } from '../deploy/CosmosNativeDeployer.js';
import { HookType } from '../hook/types.js';
import { CosmosNativeIsmModule } from '../ism/CosmosNativeIsmModule.js';
import { DerivedIsmConfig } from '../ism/types.js';
import { IsmConfig, IsmType } from '../ism/types.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { AnnotatedCosmJsNativeTransaction } from '../providers/ProviderType.js';
import { ChainName, ChainNameOrId } from '../types.js';

import {
  HyperlaneModule,
  HyperlaneModuleParams,
} from './AbstractHyperlaneModule.js';
import { CosmosNativeCoreReader } from './CosmosNativeCoreReader.js';
import { CoreConfig, CoreConfigSchema, DerivedCoreConfig } from './types.js';

export class CosmosNativeCoreModule extends HyperlaneModule<
  ProtocolType.CosmosNative,
  CoreConfig,
  Record<string, string>
> {
  protected logger = rootLogger.child({ module: 'CosmosNativeCoreModule' });
  protected coreReader: CosmosNativeCoreReader;

  public readonly chainName: ChainName;
  public readonly chainId: string;
  public readonly domainId: Domain;

  constructor(
    protected readonly multiProvider: MultiProvider,
    protected readonly signer: SigningHyperlaneModuleClient,
    args: HyperlaneModuleParams<CoreConfig, Record<string, string>>,
  ) {
    super(args);

    this.chainName = multiProvider.getChainName(args.chain);
    this.chainId = multiProvider.getChainId(args.chain).toString();
    this.domainId = multiProvider.getDomainId(args.chain);

    this.coreReader = new CosmosNativeCoreReader(this.multiProvider, signer);
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
   * @returns The created CosmosNativeCoreModule instance.
   */
  public static async create(params: {
    chain: ChainNameOrId;
    config: CoreConfig;
    multiProvider: MultiProvider;
    signer: SigningHyperlaneModuleClient;
  }): Promise<CosmosNativeCoreModule> {
    const { chain, config, multiProvider, signer } = params;
    const addresses = await CosmosNativeCoreModule.deploy({
      config,
      multiProvider,
      chain,
      signer,
    });

    // Create CoreModule and deploy the Core contracts
    const module = new CosmosNativeCoreModule(multiProvider, signer, {
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
    signer: SigningHyperlaneModuleClient;
  }): Promise<DeployedCoreAddresses> {
    const { config, multiProvider, chain, signer } = params;

    const chainName = multiProvider.getChainName(chain);
    const domainId = multiProvider.getDomainId(chain);

    const deployer = new CosmosNativeDeployer(multiProvider, signer);

    // 1. Deploy default ISM
    const ismModule = await CosmosNativeIsmModule.create({
      chain: chainName,
      config: config.defaultIsm,
      addresses: {
        deployedIsm: '',
        mailbox: '',
      },
      multiProvider,
      signer,
    });

    const { deployedIsm: defaultIsm } = ismModule.serialize();

    // 2. Deploy Mailbox with initial configuration
    const { response: mailbox } = await signer.createMailbox({
      local_domain: domainId,
      default_ism: defaultIsm,
      default_hook: '',
      required_hook: '',
    });

    // 3. Deploy default hook
    const defaultHook = await deployer.deployHook({
      chain: chainName,
      hookConfig: config.defaultHook,
      mailbox: mailbox.id,
    });

    // 4. Deploy required hook
    const requiredHook = await deployer.deployHook({
      chain: chainName,
      hookConfig: config.requiredHook,
      mailbox: mailbox.id,
    });

    // 5. Update the configuration with the newly created hooks
    await signer.setMailbox({
      mailbox_id: mailbox.id,
      default_ism: defaultIsm,
      default_hook: defaultHook,
      required_hook: requiredHook,
      new_owner: config.owner || '',
    });

    const addresses: DeployedCoreAddresses = {
      mailbox: mailbox.id,
      staticMerkleRootMultisigIsmFactory: '',
      proxyAdmin: '',
      staticMerkleRootWeightedMultisigIsmFactory: '',
      staticAggregationHookFactory: '',
      staticAggregationIsmFactory: '',
      staticMessageIdMultisigIsmFactory: '',
      staticMessageIdWeightedMultisigIsmFactory: '',
      validatorAnnounce: '',
      testRecipient: '',
      interchainAccountIsm: '',
      interchainAccountRouter: '',
      domainRoutingIsmFactory: '',
    };

    if (typeof config.defaultIsm !== 'string') {
      if (config.defaultIsm.type === IsmType.MERKLE_ROOT_MULTISIG) {
        addresses.staticMerkleRootMultisigIsmFactory = defaultIsm;
      } else if (config.defaultIsm.type === IsmType.MESSAGE_ID_MULTISIG) {
        addresses.staticMessageIdMultisigIsmFactory = defaultIsm;
      }
    }

    if (typeof config.defaultHook !== 'string') {
      if (config.defaultHook.type === HookType.INTERCHAIN_GAS_PAYMASTER) {
        addresses.interchainGasPaymaster = defaultHook;
      } else if (config.defaultHook.type === HookType.MERKLE_TREE) {
        addresses.merkleTreeHook = defaultHook;
      }
    }

    if (typeof config.requiredHook !== 'string') {
      if (config.requiredHook.type === HookType.INTERCHAIN_GAS_PAYMASTER) {
        addresses.interchainGasPaymaster = requiredHook;
      } else if (config.requiredHook.type === HookType.MERKLE_TREE) {
        addresses.merkleTreeHook = requiredHook;
      }
    }

    return addresses;
  }

  /**
   * Updates the core contracts with the provided configuration.
   *
   * @param expectedConfig - The configuration for the core contracts to be updated.
   * @returns An array of Cosmos transactions that were executed to update the contract.
   */
  public async update(
    expectedConfig: CoreConfig,
  ): Promise<AnnotatedCosmJsNativeTransaction[]> {
    CoreConfigSchema.parse(expectedConfig);
    const actualConfig = await this.read();

    let transactions: AnnotatedCosmJsNativeTransaction[] = [];
    transactions.push(
      ...(await this.createDefaultIsmUpdateTxs(actualConfig, expectedConfig)),
      ...this.createMailboxOwnerUpdateTxs(actualConfig, expectedConfig),
    );

    // TODO: what about hook updates?

    return transactions;
  }

  private createMailboxOwnerUpdateTxs(
    actualConfig: CoreConfig,
    expectedConfig: CoreConfig,
  ): AnnotatedCosmJsNativeTransaction[] {
    if (eqAddress(actualConfig.owner, expectedConfig.owner)) {
      return [];
    }

    return [
      {
        annotation: `Transferring ownership of Mailbox from ${actualConfig.owner} to ${expectedConfig.owner}`,
        typeUrl: R.MsgSetMailbox.proto.type,
        value: R.MsgSetMailbox.proto.converter.create({
          owner: actualConfig.owner,
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
  ): Promise<AnnotatedCosmJsNativeTransaction[]> {
    const updateTransactions: AnnotatedCosmJsNativeTransaction[] = [];

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
        typeUrl: R.MsgSetMailbox.proto.type,
        value: R.MsgSetMailbox.proto.converter.create({
          owner: actualConfig.owner,
          mailbox_id: mailbox,
          default_ism: deployedIsm,
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
    ismUpdateTxs: AnnotatedCosmJsNativeTransaction[];
  }> {
    const { mailbox } = this.serialize();

    const ismModule = new CosmosNativeIsmModule(
      this.multiProvider,
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
}
