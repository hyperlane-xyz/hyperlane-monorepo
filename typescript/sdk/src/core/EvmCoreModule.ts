import { Mailbox, TestRecipient } from '@hyperlane-xyz/core';
import { Address, ProtocolType, rootLogger } from '@hyperlane-xyz/utils';

import { HyperlaneContracts } from '../contracts/types.js';
import { CoreFactories } from '../core/contracts.js';
import { CoreConfig } from '../core/types.js';
import { HyperlaneProxyFactoryDeployer } from '../deploy/HyperlaneProxyFactoryDeployer.js';
import { ProxyFactoryFactories } from '../deploy/contracts.js';
import { EvmIsmModule } from '../ism/EvmIsmModule.js';
import { HyperlaneIsmFactory } from '../ism/HyperlaneIsmFactory.js';
import { InterchainAccountFactories } from '../middleware/account/contracts.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { EthersV5Transaction } from '../providers/ProviderType.js';
import { ChainMap, ChainNameOrId } from '../types.js';

import {
  HyperlaneModule,
  HyperlaneModuleArgs,
} from './AbstractHyperlaneModule.js';
import { EvmIcaModule } from './EvmIcaModule.js';
import { HyperlaneCoreDeployer } from './HyperlaneCoreDeployer.js';

type DerivedInterchainAccountFactories = HyperlaneContracts<
  Omit<InterchainAccountFactories, 'timelockController'> // Unused
>;

type ExtraArgs = {
  testRecipient: TestRecipient;
  ismFactoryFactories: HyperlaneContracts<ProxyFactoryFactories>;
} & DerivedInterchainAccountFactories;

type DerivedCoreConfig = Omit<CoreConfig, 'owner'>; // config.owner is excluded because contract owners are always 1) Deployer, or 2) Proxy Admin

export class EvmCoreModule extends HyperlaneModule<
  ProtocolType.Ethereum,
  DerivedCoreConfig,
  HyperlaneContracts<CoreFactories> & ExtraArgs
> {
  protected logger = rootLogger.child({ module: 'EvmCoreModule' });

  protected constructor(
    protected readonly multiProvider: MultiProvider,
    args: HyperlaneModuleArgs<
      DerivedCoreConfig,
      HyperlaneContracts<CoreFactories> & ExtraArgs
    >,
  ) {
    super(args);
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
    config: DerivedCoreConfig;
    multiProvider: MultiProvider;
  }): Promise<EvmCoreModule> {
    const chainName = multiProvider.getChainName(chain);

    // Deploy Ism Factories
    const { ismFactory, ismFactoriesFactory } =
      await EvmCoreModule.deployIsmFactories(chainName, config, multiProvider);

    // Initalize Deployer
    const hyperlaneCoreDeployer = new HyperlaneCoreDeployer(
      multiProvider,
      ismFactory,
    );

    // Deploy proxyAdmin
    const proxyAdmin = await EvmCoreModule.deployProxyAdmin(
      chainName,
      hyperlaneCoreDeployer,
    );

    // Deploy Mailbox
    const mailbox = await EvmCoreModule.deployMailbox(
      chainName,
      config,
      proxyAdmin.address,
      hyperlaneCoreDeployer,
      ismFactoriesFactory[chain],
      multiProvider,
    );

    // Deploy ICA ISM and Router
    const { interchainAccountRouter, interchainAccountIsm } = (
      await EvmIcaModule.create({
        chain: chainName,
        multiProvider,
        config: {
          mailbox: mailbox.address,
          owner: await multiProvider.getSigner(chain).getAddress(),
        },
      })
    ).serialize();

    // Deploy Validator announce
    const validatorAnnounce =
      await hyperlaneCoreDeployer.deployValidatorAnnounce(
        chainName,
        mailbox.address,
      );

    // Deploy Test Receipient
    const testRecipient = await hyperlaneCoreDeployer.deployTestRecipient(
      chainName,
      await mailbox.defaultIsm(),
    );

    return new EvmCoreModule(multiProvider, {
      addresses: {
        proxyAdmin,
        mailbox,
        validatorAnnounce,
        interchainAccountIsm,
        interchainAccountRouter,
        testRecipient,
        ismFactoryFactories: ismFactoriesFactory[chainName],
      },
      chain,
      config,
    });
  }

  static async deployProxyAdmin(
    chainName: string,
    hyperlaneCoreDeployer: HyperlaneCoreDeployer,
  ) {
    return hyperlaneCoreDeployer.deployContract(chainName, 'proxyAdmin', []);
  }

  static async deployIsmFactories(
    chainName: string,
    config: DerivedCoreConfig,
    multiProvider: MultiProvider,
  ): Promise<{
    ismFactory: HyperlaneIsmFactory;
    ismFactoriesFactory: ChainMap<HyperlaneContracts<ProxyFactoryFactories>>;
  }> {
    const proxyFactoryDeployer = new HyperlaneProxyFactoryDeployer(
      multiProvider,
    );
    const ismFactoriesFactory = await proxyFactoryDeployer.deploy({
      [chainName]: config,
    });
    const ismFactory = new HyperlaneIsmFactory(
      ismFactoriesFactory,
      multiProvider,
    );

    return { ismFactory, ismFactoriesFactory };
  }

  /**
   * Deploys a Mailbox and it's default ISM, hook, and required hook contracts with a given configuration.
   *
   * @param chain - The chain name or ID to deploy the Mailbox on.
   * @param config - The derived core configuration for the deployment.
   * @param proxyAdmin - The address of the proxy admin for the Mailbox contract.
   * @param deployer - The Hyperlane core deployer instance to use for the deployment.
   * @param factories - The Hyperlane contract factories to use for the deployment.
   * @param multiProvider - The multi-provider instance to use for the deployment.
   * @returns The deployed Mailbox contract instance.
   */
  static async deployMailbox(
    chain: ChainNameOrId,
    config: DerivedCoreConfig,
    proxyAdmin: Address,
    deployer: HyperlaneCoreDeployer,
    factories: HyperlaneContracts<ProxyFactoryFactories>,
    multiProvider: MultiProvider,
  ): Promise<Mailbox> {
    const chainName = multiProvider.getChainName(chain);
    const domain = deployer.multiProvider.getDomainId(chainName);
    const mailbox = await deployer.deployProxiedContract(
      chainName,
      'mailbox',
      'mailbox',
      proxyAdmin,
      [domain],
    );

    if (typeof config.defaultIsm !== 'string') {
      const evmIsmModule = await EvmIsmModule.create({
        chain,
        config: config.defaultIsm,
        deployer,
        factories,
        multiProvider,
      });

      config.defaultIsm = evmIsmModule.serialize().deployedIsm;
    }

    // @todo refactor when 1) HookModule is ready, and 2) Hooks Config can handle strings
    // The pattern should be the same as the above defaultIsm
    const deployedDefaultHook = await deployer.deployHook(
      chainName,
      config.defaultHook,
      {
        mailbox: mailbox.address,
        proxyAdmin,
      },
    );

    // @todo refactor when 1) HookModule is ready, and 2) Hooks Config can handle strings
    // The pattern should be the same as the above defaultIsm
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
        proxyAdmin,
        config.defaultIsm,
        deployedDefaultHook.address,
        deployedRequiredHook.address,
        multiProvider.getTransactionOverrides(chain),
      ),
    );
    return mailbox;
  }
}
