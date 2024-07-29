import { Mailbox } from '@hyperlane-xyz/core';
import { Address, ProtocolType, rootLogger } from '@hyperlane-xyz/utils';

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
import { HyperlaneIsmFactory } from '../ism/HyperlaneIsmFactory.js';
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

export type DeployedCoreAdresses = HyperlaneAddresses<CoreFactories> & {
  testRecipient: Address;
  timelockController?: Address; // Can be optional because it is only deployed if config.upgrade = true
  interchainAccountRouter: Address;
  interchainAccountIsm: Address;
} & HyperlaneAddresses<ProxyFactoryFactories>;

export class EvmCoreModule extends HyperlaneModule<
  ProtocolType.Ethereum,
  CoreConfig,
  DeployedCoreAdresses
> {
  protected logger = rootLogger.child({ module: 'EvmCoreModule' });
  protected coreReader: EvmCoreReader;
  public readonly chainName: string;

  protected constructor(
    protected readonly multiProvider: MultiProvider,
    args: HyperlaneModuleParams<CoreConfig, DeployedCoreAdresses>,
  ) {
    super(args);
    this.coreReader = new EvmCoreReader(multiProvider, this.args.chain);
    this.chainName = this.multiProvider.getChainName(this.args.chain);
  }

  /**
   * Reads the core configuration from the mailbox address specified in the SDK arguments.
   * @returns The core config.
   */
  public async read(): Promise<CoreConfig> {
    return this.coreReader.deriveCoreConfig(this.args.addresses.mailbox);
  }

  public async update(_config: CoreConfig): Promise<AnnotatedEV5Transaction[]> {
    throw new Error('Method not implemented.');
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
  }): Promise<DeployedCoreAdresses> {
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

    // Deploy Test Receipient
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
