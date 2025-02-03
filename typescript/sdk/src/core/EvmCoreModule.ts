import { ethers } from 'ethers';

import {
  Mailbox,
  Mailbox__factory,
  Ownable__factory,
  ProxyAdmin__factory,
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
import { ContractVerifier } from '../deploy/verify/ContractVerifier.js';
import { EvmIsmModule } from '../ism/EvmIsmModule.js';
import { DerivedIsmConfig } from '../ism/EvmIsmReader.js';
import { HyperlaneIsmFactory } from '../ism/HyperlaneIsmFactory.js';
import { IsmConfig } from '../ism/types.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { AnnotatedEV5Transaction } from '../providers/ProviderType.js';
import { ChainName, ChainNameOrId } from '../types.js';

import {
  HyperlaneModule,
  HyperlaneModuleParams,
} from './AbstractHyperlaneModule.js';
import { EvmCoreReader } from './EvmCoreReader.js';
import { EvmIcaModule } from './EvmIcaModule.js';
import { HyperlaneCoreDeployer } from './HyperlaneCoreDeployer.js';

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
    const {
      mailbox,
      domainRoutingIsmFactory,
      staticAggregationIsmFactory,
      staticAggregationHookFactory,
      staticMessageIdMultisigIsmFactory,
      staticMerkleRootMultisigIsmFactory,
      staticMerkleRootWeightedMultisigIsmFactory,
      staticMessageIdWeightedMultisigIsmFactory,
    } = this.serialize();

    const ismModule = new EvmIsmModule(this.multiProvider, {
      chain: this.args.chain,
      config: expectDefaultIsmConfig,
      addresses: {
        mailbox,
        domainRoutingIsmFactory,
        staticAggregationIsmFactory,
        staticAggregationHookFactory,
        staticMessageIdMultisigIsmFactory,
        staticMerkleRootMultisigIsmFactory,
        staticMerkleRootWeightedMultisigIsmFactory,
        staticMessageIdWeightedMultisigIsmFactory,
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
    existingAddresses?: DeployedCoreAddresses;
    deploymentPlan?: Record<keyof DeployedCoreAddresses, boolean>;
  }): Promise<EvmCoreModule> {
    const {
      chain,
      config,
      multiProvider,
      contractVerifier,
      existingAddresses,
      deploymentPlan,
    } = params;
    const addresses = await EvmCoreModule.deploy({
      config,
      multiProvider,
      chain,
      contractVerifier,
      existingAddresses,
      deploymentPlan,
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
    existingAddresses?: DeployedCoreAddresses;
    deploymentPlan?: Record<keyof DeployedCoreAddresses, boolean>;
  }): Promise<DeployedCoreAddresses> {
    const {
      config,
      multiProvider,
      chain,
      contractVerifier,
      existingAddresses,
      deploymentPlan,
    } = params;
    const chainName = multiProvider.getChainName(chain);

    // If we have existing addresses, use them as a base
    const deployedAddresses: DeployedCoreAddresses = existingAddresses
      ? { ...existingAddresses }
      : ({} as DeployedCoreAddresses);

    // Check if any ISM factories need to be deployed based on the deployment plan
    const needsIsmFactories = deploymentPlan
      ? Object.entries(proxyFactoryFactories).some(
          ([key]) => deploymentPlan[key as keyof DeployedCoreAddresses],
        )
      : !existingAddresses; // If no plan, deploy all if no existing addresses

    if (needsIsmFactories) {
      const ismFactoryFactories = await EvmCoreModule.deployIsmFactories({
        chainName,
        config,
        multiProvider,
        contractVerifier,
        existingAddresses,
        deploymentPlan,
      });
      Object.assign(deployedAddresses, ismFactoryFactories);
    }

    const ismFactory = new HyperlaneIsmFactory(
      attachContractsMap(
        { [chainName]: deployedAddresses },
        proxyFactoryFactories,
      ),
      multiProvider,
    );

    const coreDeployer = new HyperlaneCoreDeployer(
      multiProvider,
      ismFactory,
      contractVerifier,
      false,
      undefined,
      existingAddresses,
      deploymentPlan,
    );

    // Deploy proxyAdmin if it doesn't exist
    if (!existingAddresses?.proxyAdmin) {
      const proxyAdmin = await coreDeployer.deployContract(
        chainName,
        'proxyAdmin',
        [],
      );
      deployedAddresses.proxyAdmin = proxyAdmin.address;
    }

    // Deploy Mailbox if it doesn't exist
    if (!existingAddresses?.mailbox) {
      const mailbox = await this.deployMailbox({
        config,
        coreDeployer,
        proxyAdmin: deployedAddresses.proxyAdmin,
        multiProvider,
        chain,
      });
      deployedAddresses.mailbox = mailbox.address;
    }

    // Deploy ICA ISM and Router if they don't exist
    if (!existingAddresses?.interchainAccountRouter) {
      const { interchainAccountRouter, interchainAccountIsm } = (
        await EvmIcaModule.create({
          chain: chainName,
          multiProvider: multiProvider,
          config: {
            mailbox: deployedAddresses.mailbox,
            owner: await multiProvider.getSigner(chain).getAddress(),
          },
          contractVerifier,
        })
      ).serialize();
      deployedAddresses.interchainAccountRouter = interchainAccountRouter;
      deployedAddresses.interchainAccountIsm = interchainAccountIsm;
    }

    // Deploy Validator announce if it doesn't exist
    if (!existingAddresses?.validatorAnnounce) {
      const validatorAnnounce = (
        await coreDeployer.deployValidatorAnnounce(
          chainName,
          deployedAddresses.mailbox,
        )
      ).address;
      deployedAddresses.validatorAnnounce = validatorAnnounce;
    }

    // Deploy timelock controller if config.upgrade is set and it doesn't exist
    if (config.upgrade && !existingAddresses?.timelockController) {
      const timelockController = (
        await coreDeployer.deployTimelock(chainName, config.upgrade.timelock)
      ).address;
      deployedAddresses.timelockController = timelockController;
    }

    // Deploy Test Recipient if it doesn't exist
    if (!existingAddresses?.testRecipient) {
      const mailbox = Mailbox__factory.connect(
        deployedAddresses.mailbox,
        multiProvider.getProvider(chain),
      );
      const testRecipient = (
        await coreDeployer.deployTestRecipient(
          chainName,
          await mailbox.defaultIsm(),
        )
      ).address;
      deployedAddresses.testRecipient = testRecipient;
    }

    // Update the ProxyAdmin owner of the Mailbox if the config defines a different owner from the current signer
    const proxyAdmin = ProxyAdmin__factory.connect(
      deployedAddresses.proxyAdmin,
      multiProvider.getProvider(chain),
    );
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

    return deployedAddresses;
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
    existingAddresses?: DeployedCoreAddresses;
    deploymentPlan?: Record<keyof DeployedCoreAddresses, boolean>;
  }): Promise<HyperlaneAddresses<ProxyFactoryFactories>> {
    const {
      chainName,
      config,
      multiProvider,
      contractVerifier,
      existingAddresses,
      deploymentPlan,
    } = params;

    // Initialize with existing addresses if in fix mode
    const deployedFactories: HyperlaneAddresses<ProxyFactoryFactories> =
      existingAddresses
        ? {
            domainRoutingIsmFactory: existingAddresses.domainRoutingIsmFactory,
            staticAggregationIsmFactory:
              existingAddresses.staticAggregationIsmFactory,
            staticAggregationHookFactory:
              existingAddresses.staticAggregationHookFactory,
            staticMessageIdMultisigIsmFactory:
              existingAddresses.staticMessageIdMultisigIsmFactory,
            staticMerkleRootMultisigIsmFactory:
              existingAddresses.staticMerkleRootMultisigIsmFactory,
            staticMerkleRootWeightedMultisigIsmFactory:
              existingAddresses.staticMerkleRootWeightedMultisigIsmFactory,
            staticMessageIdWeightedMultisigIsmFactory:
              existingAddresses.staticMessageIdWeightedMultisigIsmFactory,
          }
        : ({} as HyperlaneAddresses<ProxyFactoryFactories>);

    // Only deploy factories that don't exist or are marked for deployment in the plan
    const proxyFactoryDeployer = new HyperlaneProxyFactoryDeployer(
      multiProvider,
      contractVerifier,
      false,
      deploymentPlan,
    );

    // Check if we need to deploy any factories based on the deployment plan
    const needsDeployment = Object.entries(proxyFactoryFactories).some(
      ([key]) =>
        !deployedFactories[key as keyof ProxyFactoryFactories] || // Missing factory
        (deploymentPlan && deploymentPlan[key as keyof DeployedCoreAddresses]), // Or marked for deployment
    );

    if (needsDeployment) {
      const newFactories: HyperlaneContractsMap<ProxyFactoryFactories> =
        await proxyFactoryDeployer.deploy({
          [chainName]: config,
        });

      const serializedNewFactories =
        serializeContractsMap(newFactories)[chainName];
      // Only assign addresses for factories that need deployment
      (
        Object.keys(serializedNewFactories) as Array<
          keyof ProxyFactoryFactories
        >
      ).forEach((key) => {
        if (
          !deployedFactories[key] || // Missing factory
          (deploymentPlan && deploymentPlan[key as keyof DeployedCoreAddresses]) // Or marked for deployment
        ) {
          deployedFactories[key] = serializedNewFactories[key];
        }
      });
    }

    return deployedFactories;
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
