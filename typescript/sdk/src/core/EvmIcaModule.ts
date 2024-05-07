import { Address, ProtocolType, rootLogger } from '@hyperlane-xyz/utils';

import { InterchainAccountDeployer } from '../middleware/account/InterchainAccountDeployer.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { ProxiedRouterConfig } from '../router/types.js';
import { ChainNameOrId } from '../types.js';

import { HyperlaneModule, HyperlaneModuleArgs } from './AbstractHyperlaneModule.js';

export type InterchainAccountConfig = ProxiedRouterConfig;

export class EvmIcaModule extends HyperlaneModule<
  ProtocolType.Ethereum,
  InterchainAccountConfig,
  {
    deployedInterchainAccountIsm: Address;
    deployedInterchainAccountRouter: Address;
  }
> {
  protected logger = rootLogger.child({ module: 'EvmIsmModule' });

  protected constructor(
    protected readonly multiProvider: MultiProvider,
    args: HyperlaneModuleArgs<
      InterchainAccountConfig,
      {
        deployedInterchainAccountIsm: Address;
        deployedInterchainAccountRouter: Address;
      }
    >,
  ) {
    super(args);
  }
  public async read(): Promise<any> {}
  public async update(): Promise<any[]> {
    return [];
  }

  public static async create({
    chain,
    config,
    multiProvider,
  }: {
    chain: ChainNameOrId;
    config: InterchainAccountConfig;
    multiProvider: MultiProvider;
  }): Promise<EvmIcaModule> {
    // Deploys an ICA with ICA-ISM
    const interchainAccountDeployer = new InterchainAccountDeployer(
      multiProvider,
    );
    const { interchainAccountIsm, interchainAccountRouter } =
      await interchainAccountDeployer.deployContracts(
        multiProvider.getChainName(chain),
        config,
      );

    return new EvmIcaModule(multiProvider, {
      addresses: {
        deployedInterchainAccountIsm: interchainAccountIsm.address,
        deployedInterchainAccountRouter: interchainAccountRouter.address,
      },
      chain,
      config,
    });
  }
}
