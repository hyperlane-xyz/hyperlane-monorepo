import { Logger } from 'pino';

import { Address, AltVM, ensure0x, rootLogger } from '@hyperlane-xyz/utils';

import { AltVMHookReader } from '../hook/AltVMHookReader.js';
import { AltVMIsmReader } from '../ism/AltVMIsmReader.js';
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

export class AltVMWarpRouteReader {
  protected readonly logger: Logger;
  hookReader: AltVMHookReader;
  ismReader: AltVMIsmReader;

  constructor(
    protected readonly metadataManager: ChainMetadataManager,
    protected readonly chain: ChainNameOrId,
    protected readonly provider: AltVM.IProvider,
  ) {
    this.hookReader = new AltVMHookReader(metadataManager, provider);
    this.ismReader = new AltVMIsmReader(metadataManager, provider);

    this.logger = rootLogger.child({
      module: AltVMWarpRouteReader.name,
    });
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
    const token = await this.provider.getToken({
      tokenAddress: warpRouteAddress,
    });

    switch (token.tokenType) {
      case AltVM.TokenType.collateral:
        return TokenType.collateral;
      case AltVM.TokenType.synthetic:
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
    const token = await this.provider.getToken({
      tokenAddress: routerAddress,
    });

    const config: MailboxClientConfig = {
      mailbox: token.mailboxAddress,
      owner: token.owner,
    };

    if (token.ismAddress) {
      const derivedIsm = await this.ismReader.deriveIsmConfig(token.ismAddress);
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
    const { remoteRouters } = await this.provider.getRemoteRouters({
      tokenAddress: warpRouteAddress,
    });

    const routers: Record<string, { address: string }> = {};
    for (const router of remoteRouters) {
      routers[router.receiverDomainId] = {
        address: ensure0x(router.receiverAddress),
      };
    }

    return RemoteRoutersSchema.parse(routers);
  }

  async fetchDestinationGas(
    warpRouteAddress: Address,
  ): Promise<DestinationGas> {
    const { remoteRouters } = await this.provider.getRemoteRouters({
      tokenAddress: warpRouteAddress,
    });

    return Object.fromEntries(
      remoteRouters.map((routerConfig) => [
        routerConfig.receiverDomainId,
        routerConfig.gas,
      ]),
    );
  }
}
