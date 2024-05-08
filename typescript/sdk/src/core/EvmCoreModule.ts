import { ProtocolType } from '@hyperlane-xyz/utils';

import { HyperlaneContracts } from '../contracts/types.js';
import { HyperlaneCoreDeployer } from '../core/HyperlaneCoreDeployer.js';
import { CoreFactories } from '../core/contracts.js';
import { CoreConfig } from '../core/types.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { ChainNameOrId } from '../types.js';

import {
  HyperlaneModule,
  HyperlaneModuleArgs,
} from './AbstractHyperlaneModule.js';

export class EvmCoreModule extends HyperlaneModule<
  ProtocolType.Ethereum,
  CoreConfig,
  HyperlaneContracts<CoreFactories>
> {
  protected constructor(
    protected readonly multiProvider: MultiProvider,
    args: HyperlaneModuleArgs<CoreConfig, HyperlaneContracts<CoreFactories>>,
  ) {
    super(args);
  }

  public static async create({
    chain,
    config,
    multiProvider,
  }: {
    chain: ChainNameOrId;
    config: CoreConfig;
    multiProvider: MultiProvider;
  }) {
    const chainName = multiProvider.getChainName(chain);
    const hyperlaneCoreDeployer = new HyperlaneCoreDeployer();

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

    // Deploy Validator announce
    // await hyperlaneCoreDeployer.deployValidatorAnnounce(
    //   chainName,
    //   mailbox.address,
    // );
    // Deploy ICA Router

    // Deploy Test Receipient
    // const testRecipient = await hyperlaneCoreDeployer.deployTestRecipient(
    //   chainName,
    //   this.cachedAddresses[chain].interchainSecurityModule,
    // );

    return {
      addresses: {
        deployedMailbox: '',
        proxyAdmin,
      },
    };
  }
}
