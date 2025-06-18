import {
  HyperlaneModuleClient,
  SigningHyperlaneModuleClient,
} from '@hyperlane-xyz/cosmos-sdk';
import { warpTypes } from '@hyperlane-xyz/cosmos-types';
import { Address, assert, rootLogger } from '@hyperlane-xyz/utils';

import { CosmosNativeHookReader } from '../hook/CosmosNativeHookReader.js';
import { CosmosNativeIsmReader } from '../ism/CosmosNativeIsmReader.js';
import { ChainMetadataManager } from '../metadata/ChainMetadataManager.js';
import {
  DestinationGas,
  MailboxClientConfig,
  RemoteRouters,
  RemoteRoutersSchema,
} from '../router/types.js';
import { ChainNameOrId, DeployedOwnableConfig } from '../types.js';

import { TokenType } from './config.js';
import { DerivedTokenRouterConfig, HypTokenConfig } from './types.js';

export class CosmosNativeWarpRouteReader {
  protected readonly logger = rootLogger.child({
    module: 'CosmosNativeWarpRouteReader',
  });
  hookReader: CosmosNativeHookReader;
  ismReader: CosmosNativeIsmReader;

  constructor(
    protected readonly metadataManager: ChainMetadataManager,
    protected readonly chain: ChainNameOrId,
    protected readonly cosmosProviderOrSigner:
      | SigningHyperlaneModuleClient
      | HyperlaneModuleClient,
  ) {
    this.hookReader = new CosmosNativeHookReader(
      metadataManager,
      cosmosProviderOrSigner,
    );
    this.ismReader = new CosmosNativeIsmReader(
      metadataManager,
      cosmosProviderOrSigner,
    );
  }

  /**
   * Derives the configuration for a Hyperlane ERC20 router contract at the given address.
   *
   * @param warpRouteAddress - The address of the Hyperlane ERC20 router contract.
   * @returns The configuration for the Hyperlane ERC20 router.
   *
   */
  async deriveWarpRouteConfig(
    warpRouteAddress: Address,
  ): Promise<DerivedTokenRouterConfig> {
    // Derive the config type
    const type = await this.deriveTokenType(warpRouteAddress);
    const baseMetadata = await this.fetchMailboxClientConfig(warpRouteAddress);
    const tokenConfig = await this.fetchTokenConfig(type, warpRouteAddress);
    const remoteRouters = await this.fetchRemoteRouters(warpRouteAddress);
    const proxyAdmin = await this.fetchProxyAdminConfig(warpRouteAddress);
    const destinationGas = await this.fetchDestinationGas(warpRouteAddress);

    return {
      ...baseMetadata,
      ...tokenConfig,
      remoteRouters,
      proxyAdmin,
      destinationGas,
      type,
    } as DerivedTokenRouterConfig;
  }

  /**
   * Derives the token type for a given Warp Route address using specific methods
   *
   * @param warpRouteAddress - The Warp Route address to derive the token type for.
   * @returns The derived token type, which can be one of: collateralVault, collateral, native, or synthetic.
   */
  async deriveTokenType(warpRouteAddress: Address): Promise<TokenType> {
    const { token } = await this.cosmosProviderOrSigner.query.warp.Token({
      id: warpRouteAddress,
    });

    if (!token) {
      throw new Error(`Failed to find token for address ${warpRouteAddress}`);
    }

    switch (token.token_type) {
      case warpTypes.HypTokenType.HYP_TOKEN_TYPE_COLLATERAL:
        return TokenType.collateral;
      case warpTypes.HypTokenType.HYP_TOKEN_TYPE_SYNTHETIC:
        return TokenType.synthetic;
      default:
        throw new Error(
          `Failed to determine token type for address ${warpRouteAddress}`,
        );
    }
  }

  /**
   * Fetches the base metadata for a Warp Route contract.
   *
   * @param routerAddress - The address of the Warp Route contract.
   * @returns The base metadata for the Warp Route contract, including the mailbox, owner, hook, and ism.
   */
  async fetchMailboxClientConfig(
    routerAddress: Address,
  ): Promise<MailboxClientConfig> {
    const { token } = await this.cosmosProviderOrSigner.query.warp.Token({
      id: routerAddress,
    });

    assert(token, `Failed to find token for address ${routerAddress}`);

    const config: MailboxClientConfig = {
      mailbox: token.origin_mailbox,
      owner: token.owner,
    };

    if (token.ism_id) {
      const derivedIsm = await this.ismReader.deriveIsmConfig(token.ism_id);
      config.interchainSecurityModule = derivedIsm;
    }

    return config;
  }

  /**
   * Fetches the metadata for a token address.
   *
   * @param warpRouteAddress - The address of the token.
   * @returns A partial ERC20 metadata object containing the token name, symbol, total supply, and decimals.
   * Throws if unsupported token type
   */
  async fetchTokenConfig(
    type: TokenType,
    warpRouteAddress: Address,
  ): Promise<HypTokenConfig> {
    return {
      type,
      token: warpRouteAddress,
    } as HypTokenConfig;
  }

  async fetchRemoteRouters(warpRouteAddress: Address): Promise<RemoteRouters> {
    const { remote_routers } =
      await this.cosmosProviderOrSigner.query.warp.RemoteRouters({
        id: warpRouteAddress,
      });

    const routers: Record<string, { address: string }> = {};
    for (const router of remote_routers) {
      routers[router.receiver_domain] = {
        address: router.receiver_contract,
      };
    }

    return RemoteRoutersSchema.parse(routers);
  }

  async fetchProxyAdminConfig(
    tokenAddress: Address,
  ): Promise<DeployedOwnableConfig> {
    const { token } = await this.cosmosProviderOrSigner.query.warp.Token({
      id: tokenAddress,
    });

    return {
      address: tokenAddress,
      owner: token?.owner ?? '',
    };
  }

  async fetchDestinationGas(
    warpRouteAddress: Address,
  ): Promise<DestinationGas> {
    const { remote_routers } =
      await this.cosmosProviderOrSigner.query.warp.RemoteRouters({
        id: warpRouteAddress,
      });

    const destinationGas: DestinationGas = {};
    for (const router of remote_routers) {
      destinationGas[router.receiver_domain] = router.gas;
    }
    return destinationGas;
  }
}
