import { ProtocolType, rootLogger } from '@hyperlane-xyz/utils';

import { HyperlaneContracts } from '../contracts/types.js';
import { CoreFactories } from '../core/contracts.js';
import { CoreConfig } from '../core/types.js';
import { HyperlaneProxyFactoryDeployer } from '../deploy/HyperlaneProxyFactoryDeployer.js';
import { ProxyFactoryFactories } from '../deploy/contracts.js';
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
  ismFactories: HyperlaneContracts<ProxyFactoryFactories>;
} & DerivedInterchainAccountFactories;

export class EvmCoreModule extends HyperlaneModule<
  ProtocolType.Ethereum,
  CoreConfig,
  HyperlaneContracts<CoreFactories> & ExtraArgs
> {
  protected logger = rootLogger.child({ module: 'EvmCoreModule' });

  protected constructor(
    protected readonly multiProvider: MultiProvider,
    args: HyperlaneModuleArgs<
      CoreConfig,
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
    const { ismFactories, ismFactory } = await EvmCoreModule.deployIsmFactories(
      chainName,
      config,
      multiProvider,
    );

    // Initalize Deployer
    const hyperlaneCoreDeployer = new HyperlaneCoreDeployer(
      multiProvider,
      ismFactory,
    );

    // Deploy proxyAdmin
    const proxyAdmin = await hyperlaneCoreDeployer.deployContract(
      chainName,
      'proxyAdmin',
      [],
    );

    // Deploy Mailbox
    const mailbox = await hyperlaneCoreDeployer.deployMailbox(
      chainName,
      config,
      proxyAdmin.address,
    );

    // Deploy Ica Router
    const evmIcaModule = await EvmIcaModule.create({
      chain: chainName,
      multiProvider,
      config: { mailbox: mailbox.address, owner: config.owner },
    });
    const { interchainAccountRouter, interchainAccountIsm } =
      evmIcaModule.serialize();

    // Deploy Validator announce
    const validatorAnnounce =
      await hyperlaneCoreDeployer.deployValidatorAnnounce(
        chainName,
        mailbox.address,
      );

    // Deploy Test Receipient
    // const testRecipient = await hyperlaneCoreDeployer.deployTestRecipient(
    //   chainName,
    //   evmIcaModule.args.config,
    // );

    return new EvmCoreModule(multiProvider, {
      addresses: {
        proxyAdmin,
        mailbox,
        validatorAnnounce,
        interchainAccountIsm,
        interchainAccountRouter,
        ismFactories: ismFactories[chainName],
      },
      chain,
      config,
    });
  }

  static async deployIsmFactories(
    chainName: string,
    config: CoreConfig,
    multiProvider: MultiProvider,
    // @NTS FIGURE THIS OUT
    // @NTS FIGURE OUT THE NAMING OF ISMFACTORY VS ISMFACTORIES. IS CONFUSING!
  ): Promise<{
    ismFactories: ChainMap<HyperlaneContracts<ProxyFactoryFactories>>;
    ismFactory: HyperlaneIsmFactory;
  }> {
    const proxyFactoryDeployer = new HyperlaneProxyFactoryDeployer(
      multiProvider,
    );
    const ismFactories = await proxyFactoryDeployer.deploy({
      [chainName]: config,
    });
    const ismFactory = new HyperlaneIsmFactory(ismFactories, multiProvider);

    return { ismFactories, ismFactory };
  }
}
