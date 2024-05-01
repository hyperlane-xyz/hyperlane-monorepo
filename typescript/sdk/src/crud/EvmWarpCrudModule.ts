import { Address, ProtocolType, rootLogger } from '@hyperlane-xyz/utils';

import { HyperlaneContracts } from '../contracts/types.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { EthersV5Transaction } from '../providers/ProviderType.js';
import { RouterConfig } from '../router/types.js';
import { TokenConfig } from '../token/config.js';
import { HypERC20Factories } from '../token/contracts.js';
import { HypERC20Deployer } from '../token/deploy.js';
import { DerivedTokenRouter, EvmERC20WarpRouteReader } from '../token/read.js';
import { TokenRouterConfig } from '../token/types.js';
import { ChainMap, ChainNameOrId } from '../types.js';

import { CrudModule, CrudModuleArgs } from './AbstractCrudModule.js';

export class EvmERC20WarpCrudModule extends CrudModule<
  ProtocolType.Ethereum,
  TokenRouterConfig,
  HyperlaneContracts<HypERC20Factories>
> {
  protected logger = rootLogger.child({ module: 'EvmERC20WarpCrudModule' });
  reader: EvmERC20WarpRouteReader;

  constructor(
    protected readonly multiProvider: MultiProvider,
    args: CrudModuleArgs<
      TokenRouterConfig,
      HyperlaneContracts<HypERC20Factories>
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
  public async read(address: Address): Promise<DerivedTokenRouter> {
    return this.reader.deriveWarpRouteConfig(address);
  }

  // Update only supports updating ISM or hook
  public async update(
    config: TokenRouterConfig,
  ): Promise<EthersV5Transaction[] | any> {
    const contractToUpdate = await this.args.addresses[
      config.type as 'collateral' // We need to cast because HypERC20Factories is a subset of TokenRouterConfig.type
    ].deployed();

    // If new config ISM is a string, try to derive it
    if (typeof config.interchainSecurityModule === 'string') {
      const ism = await this.reader.evmIsmReader.deriveIsmConfig(
        config.interchainSecurityModule as string,
      );
      return contractToUpdate.setInterchainSecurityModule(ism.address);
    } else if (typeof config.interchainSecurityModule === 'object') {
      const onchainConfig = await this.read(contractToUpdate.address);
      if (
        config.interchainSecurityModule.type !==
        onchainConfig.interchainSecurityModule?.type
      ) {
        // Deploy ISM
      }
    }
  }

  /**
   * Deploys the Warp Route
   *
   * @param chain - The chain to deploy the module on.
   * @param config - The configuration for the token router.
   * @param multiProvider - The multi-provider instance to use.
   * @returns A new instance of the EvmERC20WarpCrudModule.
   */
  public static async create({
    chain,
    config,
    multiProvider,
  }: {
    chain: ChainNameOrId;
    config: TokenRouterConfig;
    multiProvider: MultiProvider;
  }): Promise<EvmERC20WarpCrudModule> {
    const deployer = new HypERC20Deployer(multiProvider);
    const deployedContracts = await deployer.deploy({
      [chain]: config,
    } as ChainMap<TokenConfig & RouterConfig>);

    return new EvmERC20WarpCrudModule(multiProvider, {
      addresses: deployedContracts[chain],
      chain,
      config,
    });
  }
}
