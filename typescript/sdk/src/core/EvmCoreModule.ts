import { ethers } from 'ethers';

import {
  Mailbox,
  Mailbox__factory,
  Ownable__factory,
} from '@hyperlane-xyz/core';
import {
  Address,
  Domain,
  EvmChainId,
  ProtocolType,
  eqAddress,
  rootLogger,
} from '@hyperlane-xyz/utils';

import {
  attachContractsMap,
  serializeContractsMap,
  transferOwnershipTransactions,
} from '../contracts/contracts.js';
import {
  HyperlaneAddresses,
  HyperlaneContractsMap,
} from '../contracts/types.js';
import {
  CoreConfig,
  CoreConfigSchema,
  DeployedCoreAddresses,
  DerivedCoreConfig,
} from '../core/types.js';
import { HyperlaneProxyFactoryDeployer } from '../deploy/HyperlaneProxyFactoryDeployer.js';
import {
  ProxyFactoryFactories,
  proxyFactoryFactories,
} from '../deploy/contracts.js';
import { proxyAdminUpdateTxs } from '../deploy/proxy.js';
import { createDefaultProxyFactoryFactories } from '../deploy/proxyFactoryUtils.js';
import { ProxyFactoryFactoriesAddresses } from '../deploy/types.js';
import { ContractVerifier } from '../deploy/verify/ContractVerifier.js';
import { HookFactories } from '../hook/contracts.js';
import { EvmIsmModule } from '../ism/EvmIsmModule.js';
import { HyperlaneIsmFactory } from '../ism/HyperlaneIsmFactory.js';
import { DerivedIsmConfig, IsmConfig } from '../ism/types.js';
import { isStaticDeploymentSupported } from '../ism/utils.js';
import { ChainTechnicalStack } from '../metadata/chainMetadataTypes.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { AnnotatedEV5Transaction } from '../providers/ProviderType.js';
import { ChainName, ChainNameOrId } from '../types.js';
import { extractIsmAndHookFactoryAddresses } from '../utils/ism.js';

import {
  HyperlaneModule,
  HyperlaneModuleParams,
} from './AbstractHyperlaneModule.js';
import { EvmCoreReader } from './EvmCoreReader.js';
import { EvmIcaModule } from './EvmIcaModule.js';
import { HyperlaneCoreDeployer } from './HyperlaneCoreDeployer.js';
import { CoreFactories } from './contracts.js';

export class EvmCoreModule extends HyperlaneModule<
  ProtocolType.Ethereum,
  CoreConfig,
  DeployedCoreAddresses
> {
  protected logger = rootLogger.child({ module: 'EvmCoreModule' });
  protected coreReader: EvmCoreReader;
  protected evmIcaModule?: EvmIcaModule;
  public readonly chainName: ChainName;

  public readonly chainId: EvmChainId;
  public readonly domainId: Domain;

  constructor(
    protected readonly multiProvider: MultiProvider,
    args: HyperlaneModuleParams<CoreConfig, DeployedCoreAddresses>,
  ) {
    super(args);
    this.coreReader = new EvmCoreReader(multiProvider, args.chain);
    this.chainName = multiProvider.getChainName(args.chain);
    this.chainId = multiProvider.getEvmChainId(args.chain);
    this.domainId = multiProvider.getDomainId(args.chain);

    if (args.config.interchainAccountRouter) {
      this.evmIcaModule = new EvmIcaModule(multiProvider, {
        chain: args.chain,
        addresses: {
          interchainAccountIsm: args.addresses.interchainAccountIsm,
          interchainAccountRouter: args.addresses.interchainAccountRouter,
          // TODO: fix this even though is not used at the moment internally
          proxyAdmin: ethers.constants.AddressZero,
          timelockController:
            args.addresses.timelockController ?? ethers.constants.AddressZero,
        },
        config: args.config.interchainAccountRouter,
      });
    }
  }

  /**
   * Reads the core configuration from the mailbox address specified in the SDK arguments.
   * @returns The core config.
   */
  public async read(): Promise<DerivedCoreConfig> {
    return this.coreReader.deriveCoreConfig({
      mailbox: this.args.addresses.mailbox,
      interchainAccountRouter: this.args.addresses.interchainAccountRouter,
    });
  }

  /**
   * Updates the core contracts with the provided configuration.
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
      ...(await this.createDefaultIsmUpdateTxs(actualConfig, expectedConfig)),
      ...this.createMailboxOwnerUpdateTxs(actualConfig, expectedConfig),
      ...proxyAdminUpdateTxs(
        this.chainId,
        this.args.addresses.mailbox,
        actualConfig,
        expectedConfig,
      ),
    );

    if (expectedConfig.interchainAccountRouter && this.evmIcaModule) {
      transactions.push(
        ...(await this.evmIcaModule.update(
          expectedConfig.interchainAccountRouter,
        )),
      );
    }

    return transactions;
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

    const newIsmDeployed = !eqAddress(
      actualDefaultIsmConfig.address,
      deployedIsm,
    );
    if (newIsmDeployed) {
      const { mailbox } = this.serialize();
      const contractToUpdate = Mailbox__factory.connect(
        mailbox,
        this.multiProvider.getProvider(this.domainId),
      );
      updateTransactions.push({
        annotation: `Setting default ISM for Mailbox ${mailbox} to ${deployedIsm}`,
        chainId: this.chainId,
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
    const { mailbox } = this.serialize();

    const ismModule = new EvmIsmModule(this.multiProvider, {
      chain: this.args.chain,
      config: expectDefaultIsmConfig,
      addresses: {
        mailbox,
        ...extractIsmAndHookFactoryAddresses(this.serialize()),
        deployedIsm: actualDefaultIsmConfig.address,
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
  createMailboxOwnerUpdateTxs(
    actualConfig: DerivedCoreConfig,
    expectedConfig: CoreConfig,
  ): AnnotatedEV5Transaction[] {
    return transferOwnershipTransactions(
      this.chainId,
      this.args.addresses.mailbox,
      actualConfig,
      expectedConfig,
      'Mailbox',
    );
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
    const { name: chainName, technicalStack } =
      multiProvider.getChainMetadata(chain);

    const ismFactoryFactories: ProxyFactoryFactoriesAddresses =
      await this.getIsmFactoryFactories(technicalStack, {
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
    const proxyAdmin = await coreDeployer.deployContract(
      chainName,
      'proxyAdmin',
      [],
    );

    // Deploy Mailbox
    const mailbox = await this.deployMailbox({
      config,
      coreDeployer,
      proxyAdmin: proxyAdmin.address,
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

    // Obtain addresses of every contract created by the deployer
    // and extract only the merkleTreeHook and interchainGasPaymaster
    const serializedContracts = serializeContractsMap(
      coreDeployer.deployedContracts as HyperlaneContractsMap<
        CoreFactories & HookFactories
      >,
    );
    const { merkleTreeHook, interchainGasPaymaster } =
      serializedContracts[chainName];

    // Update the ProxyAdmin owner of the Mailbox if the config defines a different owner from the current signer
    const currentProxyOwner = await proxyAdmin.owner();
    if (
      config?.proxyAdmin?.owner &&
      !eqAddress(config.proxyAdmin.owner, currentProxyOwner)
    ) {
      await multiProvider.sendTransaction(chainName, {
        annotation: `Transferring ownership of ProxyAdmin to the configured address ${config.proxyAdmin.owner}`,
        to: proxyAdmin.address,
        data: Ownable__factory.createInterface().encodeFunctionData(
          'transferOwnership(address)',
          [config.proxyAdmin.owner],
        ),
      });
    }

    // Set Core & extra addresses
    return {
      ...ismFactoryFactories,
      proxyAdmin: proxyAdmin.address,
      mailbox: mailbox.address,
      interchainAccountRouter,
      interchainAccountIsm,
      validatorAnnounce,
      timelockController,
      testRecipient,
      merkleTreeHook,
      interchainGasPaymaster,
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

  /**
   * Retrieves the ISM factory factories based on the provided technicalStack and parameters.
   *
   * @param technicalStack - The protocol type to determine if static address set deployment should be skipped.
   * @param params - An object containing the parameters needed for ISM factory deployment.
   * @param params.chainName - The name of the chain for which the ISM factories are being deployed.
   * @param params.config - The core configuration to be used during deployment.
   * @param params.multiProvider - The multi-provider instance for interacting with the blockchain.
   * @param params.contractVerifier - An optional contract verifier for validating contracts during deployment.
   * @returns A promise that resolves to the addresses of the deployed ISM factory factories.
   */
  private static async getIsmFactoryFactories(
    technicalStack: ChainTechnicalStack | undefined,
    params: {
      chainName: string;
      config: CoreConfig;
      multiProvider: MultiProvider;
      contractVerifier?: ContractVerifier;
    },
  ): Promise<ProxyFactoryFactoriesAddresses> {
    // Check if we should skip static address set deployment
    if (!isStaticDeploymentSupported(technicalStack)) {
      return createDefaultProxyFactoryFactories();
    }
    return EvmCoreModule.deployIsmFactories(params);
  }
}
