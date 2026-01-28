import { AltVM, ProtocolType } from '@hyperlane-xyz/provider-sdk';
import {
  ChainLookup,
  ChainMetadataForAltVM,
} from '@hyperlane-xyz/provider-sdk/chain';
import { HypReader } from '@hyperlane-xyz/provider-sdk/module';
import {
  DerivedCollateralWarpConfig,
  DerivedNativeWarpConfig,
  DerivedSyntheticWarpConfig,
  DerivedWarpConfig,
  DestinationGas,
  RemoteRouters,
  TokenRouterModuleType,
  TokenType,
} from '@hyperlane-xyz/provider-sdk/warp';
import {
  Address,
  ensure0x,
  isZeroishAddress,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { HookReader, createHookReader } from './hook/hook-reader.js';
import { IsmReader, createIsmReader } from './ism/generic-ism.js';

export class AltVMWarpRouteReader implements HypReader<TokenRouterModuleType> {
  protected readonly logger: ReturnType<typeof rootLogger.child>;
  protected readonly hookReader: HookReader;
  private readonly ismReader: IsmReader;

  constructor(
    protected readonly chainMetadata: ChainMetadataForAltVM,
    protected readonly chainLookup: ChainLookup,
    protected readonly provider: AltVM.IProvider,
  ) {
    this.hookReader = createHookReader(this.chainMetadata, this.chainLookup);

    this.logger = rootLogger.child({
      module: AltVMWarpRouteReader.name,
    });

    this.ismReader = createIsmReader(this.chainMetadata, this.chainLookup);
  }

  /**
   * Reads the configuration for a Warp Route at the given address.
   * Implements the HypReader interface.
   *
   * @param address - The address of the Warp Route contract.
   * @returns The derived Warp Route configuration.
   */
  async read(address: string): Promise<DerivedWarpConfig> {
    return this.deriveWarpRouteConfig(address);
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
  ): Promise<DerivedWarpConfig> {
    // Fetch token info once - this gives us type, metadata, owner, mailbox, ISM, etc.
    const token = await this.provider.getToken({
      tokenAddress: warpRouteAddress,
    });

    const remoteRouters = await this.fetchRemoteRouters(warpRouteAddress);
    const destinationGas = await this.fetchDestinationGas(warpRouteAddress);

    // Derive ISM config if present, otherwise use zero address
    const interchainSecurityModule = token.ismAddress
      ? await this.ismReader.deriveIsmConfig(token.ismAddress)
      : // TODO: replace with protocol-specific zero address
        '0x0000000000000000000000000000000000000000';

    // Hook address is not exposed by providers yet, use zero address as placeholder
    // TODO: replace with protocol-specific zero address
    let hook;
    if (this.chainMetadata.protocol !== ProtocolType.Aleo) {
      hook = '0x0000000000000000000000000000000000000000';
    } else {
      hook =
        // Not using isNullish because some protocol impl might return an empty string
        token.hookAddress && !isZeroishAddress(token.hookAddress)
          ? await this.hookReader.deriveHookConfig(token.hookAddress)
          : '0x0000000000000000000000000000000000000000';
    }

    const baseConfig = {
      owner: token.owner,
      mailbox: token.mailboxAddress,
      interchainSecurityModule,
      hook,
      remoteRouters,
      destinationGas,
      name: token.name ?? undefined,
      symbol: token.symbol ?? undefined,
      decimals: token.decimals ?? undefined,
    };

    // Return discriminated union based on type
    switch (token.tokenType) {
      case AltVM.TokenType.native: {
        const nativeConfig: DerivedNativeWarpConfig = {
          ...baseConfig,
          type: TokenType.native,
        };
        return nativeConfig;
      }
      case AltVM.TokenType.collateral: {
        const collateralConfig: DerivedCollateralWarpConfig = {
          ...baseConfig,
          type: TokenType.collateral,
          token: token.denom, // The underlying collateral denom
        };
        return collateralConfig;
      }
      case AltVM.TokenType.synthetic: {
        const syntheticConfig: DerivedSyntheticWarpConfig = {
          ...baseConfig,
          type: TokenType.synthetic,
        };
        return syntheticConfig;
      }
      default:
        throw new Error(
          `Failed to determine token type for address ${warpRouteAddress}`,
        );
    }
  }

  /**
   * Derives the token type for a given Warp Route address using specific methods
   *
   * @param warpRouteAddress - The Warp Route address to derive the token type for.
   * @returns The derived TokenType, which can be either 'collateral' or 'synthetic'.
   * @throws Error if the token type is not supported (i.e., not collateral or synthetic).
   */
  async deriveTokenType(warpRouteAddress: Address): Promise<TokenType> {
    const token = await this.provider.getToken({
      tokenAddress: warpRouteAddress,
    });

    switch (token.tokenType) {
      case AltVM.TokenType.native:
        return TokenType.native;
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
  async fetchMailboxClientConfig(routerAddress: Address): Promise<{
    mailbox: string;
    owner: string;
    interchainSecurityModule?: any;
  }> {
    const token = await this.provider.getToken({
      tokenAddress: routerAddress,
    });

    const config: any = {
      mailbox: token.mailboxAddress,
      owner: token.owner,
    };

    if (token.ismAddress) {
      const derivedIsm = await this.ismReader.deriveIsmConfig(token.ismAddress);
      config.interchainSecurityModule = derivedIsm;
    }

    return config;
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

    return routers;
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
