import { RadixSigningSDK } from '@hyperlane-xyz/radix-sdk';
import { Address, rootLogger } from '@hyperlane-xyz/utils';

import { RadixHookReader } from '../hook/RadixHookReader.js';
import { RadixIsmReader } from '../ism/RadixIsmReader.js';
import { ChainMetadataManager } from '../metadata/ChainMetadataManager.js';
import {
  DestinationGas,
  MailboxClientConfig,
  RemoteRouters,
  RemoteRoutersSchema,
} from '../router/types.js';
import { ChainNameOrId } from '../types.js';

import { TokenType } from './config.js';
import { DerivedTokenRouterConfig, HypTokenConfig } from './types.js';

export class RadixWarpRouteReader {
  protected readonly logger = rootLogger.child({
    module: 'RadixWarpRouteReader',
  });
  hookReader: RadixHookReader;
  ismReader: RadixIsmReader;

  constructor(
    protected readonly metadataManager: ChainMetadataManager,
    protected readonly chain: ChainNameOrId,
    protected readonly signer: RadixSigningSDK,
  ) {
    this.hookReader = new RadixHookReader(metadataManager, signer);
    this.ismReader = new RadixIsmReader(metadataManager, signer);
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
    const destinationGas = await this.fetchDestinationGas(warpRouteAddress);

    return {
      ...baseMetadata,
      ...tokenConfig,
      remoteRouters,
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
    // TODO: RADIX
    return TokenType.collateral;
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
    // TODO: RADIX
    const config: MailboxClientConfig = {
      mailbox: '',
      owner: '',
      interchainSecurityModule: '',
    };

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
    // TODO: RADIX
    return RemoteRoutersSchema.parse({});
  }

  async fetchDestinationGas(
    warpRouteAddress: Address,
  ): Promise<DestinationGas> {
    // TODO: RADIX
    return {};
  }
}
