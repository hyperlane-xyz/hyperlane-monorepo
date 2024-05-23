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
import { HyperlaneIsmFactory } from '../ism/HyperlaneIsmFactory.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { EthersV5Transaction } from '../providers/ProviderType.js';
import { ChainNameOrId } from '../types.js';

import {
  HyperlaneModule,
  HyperlaneModuleArgs,
} from './AbstractHyperlaneModule.js';
import { EvmIcaModule } from './EvmIcaModule.js';
import { HyperlaneCoreDeployer } from './HyperlaneCoreDeployer.js';
import { CoreFactories } from './contracts.js';

// Partial CoreConfig because will be filled once .deploy() is called
type DeployedAdresses = Partial<HyperlaneAddresses<CoreFactories>> & {
  testRecipient?: Address;
  timelockController?: Address;
  interchainAccountRouter?: Address;
  interchainAccountIsm?: Address;
  deployedIsmFactoryFactories: HyperlaneAddresses<ProxyFactoryFactories>;
};
export class EvmCoreModule extends HyperlaneModule<
  ProtocolType.Ethereum,
  CoreConfig,
  DeployedAdresses
> {
  public readonly chainName: string;
  protected logger = rootLogger.child({ module: 'EvmCoreModule' });
  protected hyperlaneCoreDeployer: HyperlaneCoreDeployer;

  protected constructor(
    protected readonly multiProvider: MultiProvider,
    args: HyperlaneModuleArgs<CoreConfig, DeployedAdresses>,
  ) {
    super(args);
    this.chainName = this.multiProvider.getChainName(this.args.chain);

    // Deploy IsmFactory to be used in CoreDeployer
    const ismFactory = new HyperlaneIsmFactory(
      attachContractsMap(
        { [this.chainName]: this.args.addresses.deployedIsmFactoryFactories },
        proxyFactoryFactories,
      ),
      multiProvider,
    );

    // Initalize Deployer
    this.hyperlaneCoreDeployer = new HyperlaneCoreDeployer(
      multiProvider,
      ismFactory,
    );
  }

  public async read(): Promise<CoreConfig> {
    throw new Error('Method not implemented.');
  }

  public async update(_config: CoreConfig): Promise<EthersV5Transaction[]> {
    throw new Error('Method not implemented.');
  }

  /**
   * Deploys the Core contracts
   *
   * @remark Most of the contract owners are the deployers with some being the Proxy Admin
   *
   * @param chain - The chain name or ID to deploy the Hyperlane contracts on.
   * @param config - The derived core configuration for the deployment.
   * @param multiProvider - The multi-provider instance to use for the deployment.
   * @returns The created EvmCoreModule instance.
   */
  public static async create({
    chain,
    config,
    multiProvider,
  }: {
    chain: ChainNameOrId;
    config: CoreConfig;
    multiProvider: MultiProvider;
  }): Promise<EvmCoreModule> {
    const chainName = multiProvider.getChainName(chain);
    // Deploy Ism Factories
    const ismFactoriesFactory = await EvmCoreModule.deployIsmFactories(
      chainName,
      config,
      multiProvider,
    );

    // Create CoreModule and deploy the Core contracts
    const module = new EvmCoreModule(multiProvider, {
      addresses: {
        deployedIsmFactoryFactories: ismFactoriesFactory,
      },
      chain,
      config,
    });
    await module.deploy(config);

    return module;
  }

  /**
   * Deploys the core Hyperlane contracts (Mailbox, ICA ISM and Router, Validator Announce, Timelock, Test Recipient)
   *
   * Also, sets the arg addresses in the module's configuration.
   *
   * @param proxyAdmin - The address of the proxy admin for the Mailbox contract.
   * @returns The deployed Mailbox contract instance.
   */
  async deploy(config: CoreConfig) {
    // Deploy proxyAdmin
    const proxyAdmin = await this.hyperlaneCoreDeployer.deployContract(
      this.chainName,
      'proxyAdmin',
      [],
    );

    // Deploy Mailbox
    const mailbox = await this.deployMailbox(proxyAdmin.address);

    // Deploy ICA ISM and Router
    const { interchainAccountRouter, interchainAccountIsm } = (
      await EvmIcaModule.create({
        chain: this.chainName,
        multiProvider: this.multiProvider,
        config: {
          mailbox: mailbox.address,
          owner: await this.multiProvider
            .getSigner(this.args.chain)
            .getAddress(),
        },
      })
    ).serialize();

    // Deploy Validator announce
    const validatorAnnounce =
      await this.hyperlaneCoreDeployer.deployValidatorAnnounce(
        this.chainName,
        mailbox.address,
      );

    // Deploy timelock controller if config.upgrade is set
    if (config.upgrade) {
      this.args.addresses.timelockController = (
        await this.hyperlaneCoreDeployer.deployTimelock(
          this.chainName,
          config.upgrade.timelock,
        )
      ).address;
    }

    // Deploy Test Receipient
    const testRecipient = await this.hyperlaneCoreDeployer.deployTestRecipient(
      this.chainName,
      await mailbox.defaultIsm(),
    );

    // Set Core and extra addresses
    this.args.addresses = {
      ...this.args.addresses,
      mailbox: mailbox.address,
      proxyAdmin: proxyAdmin.address,
      validatorAnnounce: validatorAnnounce.address,
      testRecipient: testRecipient.address,
      interchainAccountRouter,
      interchainAccountIsm,
    };
  }

  /**
   * Deploys the ISM factories for a given chain.
   *
   * @param chainName - The name of chain to deploy the ISM factories on.
   * @param config - The core configuration for the deployment.
   * @param multiProvider - The multi-provider instance to use for the deployment.
   * @returns The deployed ISM factories
   */
  static async deployIsmFactories(
    chainName: string,
    config: CoreConfig,
    multiProvider: MultiProvider,
  ): Promise<HyperlaneAddresses<ProxyFactoryFactories>> {
    // ChainMap is still needed for HyperlaneIsmFactory
    const proxyFactoryDeployer = new HyperlaneProxyFactoryDeployer(
      multiProvider,
    );
    const ismFactoriesFactory = await proxyFactoryDeployer.deploy({
      [chainName]: config,
    });

    return serializeContractsMap(ismFactoriesFactory)[chainName];
  }

  /**
   * Deploys a Mailbox and it's default ISM, hook, and required hook contracts with a given configuration.
   *
   * @param proxyAdmin - The address of the proxy admin for the Mailbox contract.
   * @returns The deployed Mailbox contract instance.
   */
  protected async deployMailbox(proxyAdmin: Address): Promise<Mailbox> {
    const domain = this.multiProvider.getDomainId(this.chainName);
    const mailbox = await this.hyperlaneCoreDeployer.deployProxiedContract(
      this.chainName,
      'mailbox',
      'mailbox',
      proxyAdmin,
      [domain],
    );

    const deployedDefaultIsm = await this.hyperlaneCoreDeployer.deployIsm(
      this.chainName,
      this.args.config.defaultIsm,
      mailbox.address,
    );

    // @todo refactor when 1) HookModule is ready, and 2) Hooks Config can handle strings
    // The pattern should be the same as the above defaultIsm
    const deployedDefaultHook = await this.hyperlaneCoreDeployer.deployHook(
      this.chainName,
      this.args.config.defaultHook,
      {
        mailbox: mailbox.address,
        proxyAdmin,
      },
    );

    // @todo refactor when 1) HookModule is ready, and 2) Hooks Config can handle strings
    // The pattern should be the same as the above defaultIsm
    const deployedRequiredHook = await this.hyperlaneCoreDeployer.deployHook(
      this.chainName,
      this.args.config.requiredHook,
      {
        mailbox: mailbox.address,
        proxyAdmin,
      },
    );

    // Initialize Mailbox
    await this.multiProvider.handleTx(
      this.args.chain,
      mailbox.initialize(
        proxyAdmin,
        deployedDefaultIsm,
        deployedDefaultHook.address,
        deployedRequiredHook.address,
        this.multiProvider.getTransactionOverrides(this.args.chain),
      ),
    );
    return mailbox;
  }
}
