import { Address, ProtocolType, rootLogger } from '@hyperlane-xyz/utils';

import { serializeContracts } from '../contracts/contracts.js';
import { HyperlaneAddresses } from '../contracts/types.js';
import {
  HyperlaneModule,
  HyperlaneModuleArgs,
} from '../core/AbstractHyperlaneModule.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { EthersV5Transaction } from '../providers/ProviderType.js';
import { RouterConfig } from '../router/types.js';
import { ChainMap, ChainNameOrId } from '../types.js';

import {
  DerivedTokenRouterConfig,
  DerivedTokenType,
  EvmERC20WarpRouteReader,
} from './EvmERC20WarpRouteReader.js';
import { TokenConfig } from './config.js';
import { HypERC20Factories } from './contracts.js';
import { HypERC20Deployer } from './deploy.js';

export class EvmERC20WarpModule extends HyperlaneModule<
  ProtocolType.Ethereum,
  DerivedTokenRouterConfig,
  HyperlaneAddresses<HypERC20Factories> & {
    deployedTokenRoute: Address;
  }
> {
  protected logger = rootLogger.child({
    module: 'EvmERC20WarpModule',
  });
  reader: EvmERC20WarpRouteReader;

  constructor(
    protected readonly multiProvider: MultiProvider,
    args: HyperlaneModuleArgs<
      DerivedTokenRouterConfig,
      HyperlaneAddresses<HypERC20Factories> & {
        deployedTokenRoute: Address;
      }
    >,
  ) {
    super(args);

    this.reader = new EvmERC20WarpRouteReader(multiProvider, args.chain);
  }

  /**
   * Retrieves the token router configuration for the specified address.
   *
   * @param address - The address to derive the token router configuration from.
   * @returns A promise that resolves to the token router configuration.
   */
  public async read(): Promise<DerivedTokenRouterConfig> {
    return this.reader.deriveWarpRouteConfig(
      this.args.addresses.deployedTokenRoute,
    );
  }

  /**
   * Updates the Warp Route contract with the provided configuration.
   *
   * @remark Currently only supports updating ISM or hook.
   *
   * @param expectedConfig - The configuration for the token router to be updated.
   * @returns An array of Ethereum transactions that were executed to update the contract, or an error if the update failed.
   */
  public async update(
    _expectedConfig: DerivedTokenRouterConfig,
  ): Promise<EthersV5Transaction[]> {
    throw Error('Not implemented');
  }

  /**
   * Deploys the Warp Route.
   *
   * @param chain - The chain to deploy the module on.
   * @param config - The configuration for the token router.
   * @param multiProvider - The multi-provider instance to use.
   * @returns A new instance of the EvmERC20WarpHyperlaneModule.
   */
  public static async create(params: {
    chain: ChainNameOrId;
    config: DerivedTokenRouterConfig;
    multiProvider: MultiProvider;
  }): Promise<EvmERC20WarpModule> {
    const { chain, config, multiProvider } = params;
    const deployer = new HypERC20Deployer(multiProvider);
    const deployedContracts = (
      await deployer.deploy({
        [chain]: config,
      } as ChainMap<TokenConfig & RouterConfig>)
    )[chain];

    return new EvmERC20WarpModule(multiProvider, {
      addresses: {
        ...serializeContracts(deployedContracts),
        deployedTokenRoute:
          deployedContracts[config.type as DerivedTokenType].address,
      },
      chain,
      config,
    });
  }
}
