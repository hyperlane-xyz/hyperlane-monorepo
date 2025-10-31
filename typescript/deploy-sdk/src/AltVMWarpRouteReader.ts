import { AltVM } from '@hyperlane-xyz/provider-sdk';
import { ChainLookup } from '@hyperlane-xyz/provider-sdk/chain';
import {
  DerivedCollateralWarpConfig,
  DerivedSyntheticWarpConfig,
  DerivedWarpConfig,
  DestinationGas,
  RemoteRouters,
  TokenType,
} from '@hyperlane-xyz/provider-sdk/warp';
import { Address, ensure0x, rootLogger } from '@hyperlane-xyz/utils';

import { AltVMHookReader } from './AltVMHookReader.js';
import { AltVMIsmReader } from './AltVMIsmReader.js';

export class AltVMWarpRouteReader {
  protected readonly logger: ReturnType<typeof rootLogger.child>;
  hookReader: AltVMHookReader;
  ismReader: AltVMIsmReader;

  constructor(
    chainLookup: ChainLookup,
    protected readonly provider: AltVM.IProvider,
  ) {
    this.hookReader = new AltVMHookReader(
      chainLookup.getChainMetadata,
      provider,
    );
    this.ismReader = new AltVMIsmReader(chainLookup.getChainName, provider);

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
    const hook = '0x0000000000000000000000000000000000000000';

    const baseConfig = {
      owner: token.owner,
      mailbox: token.mailboxAddress,
      interchainSecurityModule,
      hook,
      remoteRouters,
      destinationGas,
      name: token.name || undefined,
      symbol: token.symbol || undefined,
      decimals: token.decimals || undefined,
    };

    // Return discriminated union based on type
    switch (token.tokenType) {
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
