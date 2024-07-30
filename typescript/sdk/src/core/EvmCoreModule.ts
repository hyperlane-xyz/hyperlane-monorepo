import { Mailbox, Mailbox__factory } from '@hyperlane-xyz/core';
import {
  Address,
  Domain,
  ProtocolType,
  assert,
  rootLogger,
} from '@hyperlane-xyz/utils';

import {
  attachContractsMap,
  serializeContractsMap,
} from '../contracts/contracts.js';
import { HyperlaneAddresses } from '../contracts/types.js';
import { CoreConfig } from '../core/types.js';
import { HyperlaneProxyFactoryDeployer } from '../deploy/HyperlaneProxyFactoryDeployer.js';
import {
  ProxyFactoryFactories,
  proxyFactoryFactories,
} from '../deploy/contracts.js';
import { ContractVerifier } from '../deploy/verify/ContractVerifier.js';
import { EvmIsmModule } from '../ism/EvmIsmModule.js';
import { DerivedIsmConfig } from '../ism/EvmIsmReader.js';
import { HyperlaneIsmFactory } from '../ism/HyperlaneIsmFactory.js';
import { IsmConfig } from '../ism/types.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { AnnotatedEV5Transaction } from '../providers/ProviderType.js';
import { ChainNameOrId } from '../types.js';

import {
  HyperlaneModule,
  HyperlaneModuleParams,
} from './AbstractHyperlaneModule.js';
import { EvmCoreReader } from './EvmCoreReader.js';
import { EvmIcaModule } from './EvmIcaModule.js';
import { HyperlaneCoreDeployer } from './HyperlaneCoreDeployer.js';
import { CoreFactories } from './contracts.js';
import { CoreConfigSchema } from './schemas.js';

type DeployedCoreAddresses = Partial<
  HyperlaneAddresses<CoreFactories> & {
    testRecipient: Address;
    timelockController: Address;
    interchainAccountRouter: Address;
    interchainAccountIsm: Address;
  } & HyperlaneAddresses<ProxyFactoryFactories>
>;

export class EvmCoreModule extends HyperlaneModule<
  ProtocolType.Ethereum,
  CoreConfig,
  DeployedCoreAddresses
> {
  protected logger = rootLogger.child({ module: 'EvmCoreModule' });
  protected coreReader: EvmCoreReader;
  public readonly chainName: string;

  // We use domainId here because MultiProvider.getDomainId() will always
  // return a number, and EVM the domainId and chainId are the same.
  public readonly domainId: Domain;

  constructor(
    protected readonly multiProvider: MultiProvider,
    args: HyperlaneModuleParams<CoreConfig, DeployedCoreAddresses>,
  ) {
    super(args);
    this.coreReader = new EvmCoreReader(multiProvider, this.args.chain);
    this.chainName = this.multiProvider.getChainName(this.args.chain);
    this.domainId = multiProvider.getDomainId(args.chain);
  }

  /**
   * Reads the core configuration from the mailbox address specified in the SDK arguments.
   * @returns The core config.
   */
  public async read(): Promise<CoreConfig> {
    assert(this.args.addresses.mailbox, 'Mailbox not provided for read');
    return this.coreReader.deriveCoreConfig(this.args.addresses.mailbox);
  }

  /**
   * Updates the core contracts with the provided configuration
   *
   * @param expectedConfig - The configuration for the core contracts to be updated.
   * @returns An array of Ethereum transactions that were executed to update the contract.
   */
  public async update(
    expectedConfig: CoreConfig,
  ): Promise<AnnotatedEV5Transaction[]> {
    CoreConfigSchema.parse(expectedConfig);
    const actualConfig = await this.read();

    const transactions: AnnotatedEV5Transaction[] = [];

    transactions.push(
      ...(await this.createUpdateDefaultIsmTx(actualConfig, expectedConfig)),
      ...this.createMailboxOwnershipTransferTx(actualConfig, expectedConfig),
    );

    return transactions;
  }

  /**
   * Create a transaction to update an existing default ISM with a given config.
   *
   * @param actualConfig - The on-chain router configuration, including the ISM configuration, and address.
   * @param expectedConfig - The expected token router configuration, including the ISM configuration.
   * @returns Transaction that need to be executed to update the ISM configuration.
   */
  async createUpdateDefaultIsmTx(
    actualConfig: CoreConfig,
    expectedConfig: CoreConfig,
  ): Promise<AnnotatedEV5Transaction[]> {
    const updateTransactions: AnnotatedEV5Transaction[] = [];

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
      const contractToUpdate = Mailbox__factory.connect(
        mailbox!,
        this.multiProvider.getProvider(this.domainId),
      );
      updateTransactions.push({
        annotation: `Setting default ISM for Mailbox ${mailbox!} to ${deployedIsm}`,
        chainId: this.domainId,
        to: contractToUpdate.address,
        data: contractToUpdate.interface.encodeFunctionData('setDefaultIsm', [
          deployedIsm,
        ]),
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
    ismUpdateTxs: AnnotatedEV5Transaction[];
  }> {
    const addresses = this.serialize();

    const ismModule = new EvmIsmModule(this.multiProvider, {
      chain: this.args.chain,
      config: expectDefaultIsmConfig,
      addresses: {
        deployedIsm: actualDefaultIsmConfig.address,
        mailbox: addresses.mailbox!,
        staticAggregationIsmFactory: addresses.staticAggregationIsmFactory!,
        staticMerkleRootMultisigIsmFactory:
          addresses.staticMerkleRootMultisigIsmFactory!,
        staticMessageIdMultisigIsmFactory:
          addresses.staticMessageIdMultisigIsmFactory!,
        domainRoutingIsmFactory: addresses.domainRoutingIsmFactory!,
        staticAggregationHookFactory: addresses.staticAggregationHookFactory!,
      },
    });
    this.logger.info(
      `Comparing target ISM config with ${this.args.chain} chain`,
    );
    const ismUpdateTxs = await ismModule.update(expectDefaultIsmConfig);
    const { deployedIsm } = ismModule.serialize();

    return { deployedIsm, ismUpdateTxs };
  }

  /**
   * Create a transaction to transfer ownership of an existing mailbox with a given config.
   *
   * @param actualConfig - The on-chain core configuration.
   * @param expectedConfig - The expected token core configuration.
   * @returns Ethereum transaction that need to be executed to update the owner.
   */
  createMailboxOwnershipTransferTx(
    actualConfig: CoreConfig,
    expectedConfig: CoreConfig,
  ): AnnotatedEV5Transaction[] {
    assert(
      this.args.addresses.mailbox,
      'Mailbox not provided for update ownership',
    );

    return EvmCoreModule.createTransferOwnershipTx({
      actualOwner: actualConfig.owner,
      expectedOwner: expectedConfig.owner,
      deployedAddress: this.args.addresses.mailbox,
      chainId: this.domainId,
    });
  }

  /**
   * Deploys the Core contracts.
   * @remark Most of the contract owners is the Deployer with some being the Proxy Admin.
   * @returns The created EvmCoreModule instance.
   */
  public static async create(params: {
    chain: ChainNameOrId;
    config: CoreConfig;
    multiProvider: MultiProvider;
    contractVerifier?: ContractVerifier;
  }): Promise<EvmCoreModule> {
    const { chain, config, multiProvider, contractVerifier } = params;
    const addresses = await EvmCoreModule.deploy({
      config,
      multiProvider,
      chain,
      contractVerifier,
    });

    // Create CoreModule and deploy the Core contracts
    const module = new EvmCoreModule(multiProvider, {
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
    contractVerifier?: ContractVerifier;
  }): Promise<DeployedCoreAddresses> {
    const { config, multiProvider, chain, contractVerifier } = params;
    const chainName = multiProvider.getChainName(chain);

    const ismFactoryFactories = await EvmCoreModule.deployIsmFactories({
      chainName,
      config,
      multiProvider,
      contractVerifier,
    });

    const ismFactory = new HyperlaneIsmFactory(
      attachContractsMap(
        { [chainName]: ismFactoryFactories },
        proxyFactoryFactories,
      ),
      multiProvider,
    );

    const coreDeployer = new HyperlaneCoreDeployer(
      multiProvider,
      ismFactory,
      contractVerifier,
    );

    // Deploy proxyAdmin
    const proxyAdmin = (
      await coreDeployer.deployContract(chainName, 'proxyAdmin', [])
    ).address;

    // Deploy Mailbox
    const mailbox = await this.deployMailbox({
      config,
      coreDeployer,
      proxyAdmin,
      multiProvider,
      chain,
    });

    // Deploy ICA ISM and Router
    const { interchainAccountRouter, interchainAccountIsm } = (
      await EvmIcaModule.create({
        chain: chainName,
        multiProvider: multiProvider,
        config: {
          mailbox: mailbox.address,
          owner: await multiProvider.getSigner(chain).getAddress(),
        },
        contractVerifier,
      })
    ).serialize();

    // Deploy Validator announce
    const validatorAnnounce = (
      await coreDeployer.deployValidatorAnnounce(chainName, mailbox.address)
    ).address;

    // Deploy timelock controller if config.upgrade is set
    let timelockController;
    if (config.upgrade) {
      timelockController = (
        await coreDeployer.deployTimelock(chainName, config.upgrade.timelock)
      ).address;
    }

    // Deploy Test Recipient
    const testRecipient = (
      await coreDeployer.deployTestRecipient(
        chainName,
        await mailbox.defaultIsm(),
      )
    ).address;

    // Set Core & extra addresses
    return {
      ...ismFactoryFactories,
      proxyAdmin,
      mailbox: mailbox.address,
      interchainAccountRouter,
      interchainAccountIsm,
      validatorAnnounce,
      timelockController,
      testRecipient,
    };
  }

  /**
   * Deploys the ISM factories for a given chain.
   * @returns The deployed ISM factories addresses.
   */
  static async deployIsmFactories(params: {
    chainName: string;
    config: CoreConfig;
    multiProvider: MultiProvider;
    contractVerifier?: ContractVerifier;
  }): Promise<HyperlaneAddresses<ProxyFactoryFactories>> {
    const { chainName, config, multiProvider, contractVerifier } = params;

    const proxyFactoryDeployer = new HyperlaneProxyFactoryDeployer(
      multiProvider,
      contractVerifier,
    );
    const ismFactoriesFactory = await proxyFactoryDeployer.deploy({
      [chainName]: config,
    });

    return serializeContractsMap(ismFactoriesFactory)[chainName];
  }

  /**
   * Deploys a Mailbox and its default ISM, hook, and required hook contracts with a given configuration.
   * @returns The deployed Mailbox contract instance.
   */
  static async deployMailbox(params: {
    config: CoreConfig;
    proxyAdmin: Address;
    coreDeployer: HyperlaneCoreDeployer;
    multiProvider: MultiProvider;
    chain: ChainNameOrId;
  }): Promise<Mailbox> {
    const {
      config,
      proxyAdmin,
      coreDeployer: deployer,
      multiProvider,
      chain,
    } = params;
    const chainName = multiProvider.getChainName(chain);

    const domain = multiProvider.getDomainId(chainName);
    const mailbox = await deployer.deployProxiedContract(
      chainName,
      'mailbox',
      'mailbox',
      proxyAdmin,
      [domain],
    );

    // @todo refactor when 1) IsmModule is ready
    const deployedDefaultIsm = await deployer.deployIsm(
      chainName,
      config.defaultIsm,
      mailbox.address,
    );

    // @todo refactor when 1) HookModule is ready, and 2) Hooks Config can handle strings
    const deployedDefaultHook = await deployer.deployHook(
      chainName,
      config.defaultHook,
      {
        mailbox: mailbox.address,
        proxyAdmin,
      },
    );

    // @todo refactor when 1) HookModule is ready, and 2) Hooks Config can handle strings
    const deployedRequiredHook = await deployer.deployHook(
      chainName,
      config.requiredHook,
      {
        mailbox: mailbox.address,
        proxyAdmin,
      },
    );

    // Initialize Mailbox
    await multiProvider.handleTx(
      chain,
      mailbox.initialize(
        config.owner,
        deployedDefaultIsm,
        deployedDefaultHook.address,
        deployedRequiredHook.address,
        multiProvider.getTransactionOverrides(chain),
      ),
    );
    return mailbox;
  }
}
