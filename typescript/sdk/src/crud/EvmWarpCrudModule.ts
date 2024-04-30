import { Address, ProtocolType, rootLogger } from '@hyperlane-xyz/utils';

import { HyperlaneAddresses } from '../contracts/types.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { EthersV5Transaction } from '../providers/ProviderType.js';
import { RouterConfig } from '../router/types.js';
import { TokenConfig } from '../token/config.js';
import { HypERC20Factories } from '../token/contracts.js';
import { HypERC20Deployer } from '../token/deploy.js';
import { EvmERC20WarpRouteReader } from '../token/read.js';
import { TokenRouterConfig } from '../token/types.js';
import { ChainMap } from '../types.js';

import { CrudModule, CrudModuleArgs } from './AbstractCrudModule.js';

export class EvmERC20WarpCrudModule extends CrudModule<
  ProtocolType.Ethereum,
  TokenRouterConfig,
  HyperlaneAddresses<HypERC20Factories>
> {
  protected logger = rootLogger.child({ module: 'EvmERC20WarpCrudModule' });
  protected reader: EvmERC20WarpRouteReader;
  protected deployer: HypERC20Deployer;

  constructor(
    protected readonly multiProvider: MultiProvider,
    args: Omit<
      CrudModuleArgs<
        ProtocolType.Ethereum,
        TokenRouterConfig,
        HyperlaneAddresses<HypERC20Factories>
      >,
      'provider'
    >,
  ) {
    super({
      ...args,
      provider: multiProvider.getProvider(args.chain),
    });

    this.reader = new EvmERC20WarpRouteReader(multiProvider, args.chain);
    this.deployer = new HypERC20Deployer(this.multiProvider);
  }

  /**
   * Retrieves the token router configuration for the specified address.
   *
   * @param address - The address to derive the token router configuration from.
   * @returns A promise that resolves to the token router configuration.
   */
  public async read(address: Address): Promise<TokenRouterConfig> {
    return this.reader.deriveWarpRouteConfig(address);
  }

  public async update(
    _config: TokenRouterConfig,
  ): Promise<EthersV5Transaction[]> {
    throw new Error('Method not implemented.');
  }

  /**
   * Deploys a new token router using the specified deployer and config
   *
   * @param config - The token router config to deploy.
   * @returns A promise that resolves to the deployment result.
   */
  public async create(config: TokenRouterConfig): Promise<any> {
    return this.deployer.deploy({ [this.args.chain]: config } as ChainMap<
      TokenConfig & RouterConfig
    >);
  }
}
