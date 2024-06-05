import { BigNumber, constants, providers } from 'ethers';

import {
  HypERC20CollateralVaultDeposit__factory,
  HypERC20Collateral__factory,
  HypERC20__factory,
} from '@hyperlane-xyz/core';
import { HookConfig, TokenRouterConfig, TokenType } from '@hyperlane-xyz/sdk';
import { Address, eqAddress, rootLogger } from '@hyperlane-xyz/utils';

import { DEFAULT_CONTRACT_READ_CONCURRENCY } from '../consts/concurrency.js';
import { DerivedHookConfig, EvmHookReader } from '../hook/EvmHookReader.js';
import { DerivedIsmConfig, EvmIsmReader } from '../ism/EvmIsmReader.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { ChainNameOrId } from '../types.js';

import { TokenMetadata } from './types.js';

type WarpRouteBaseMetadata = Record<'mailbox' | 'owner', string> & {
  hook?: HookConfig;
  interchainSecurityModule?: DerivedIsmConfig;
};

export type DerivedTokenRouterConfig = TokenRouterConfig & {
  hook?: DerivedHookConfig;
  interchainSecurityModule?: DerivedIsmConfig;
};

export class EvmERC20WarpRouteReader {
  protected readonly logger = rootLogger.child({
    module: 'EvmERC20WarpRouteReader',
  });
  provider: providers.Provider;
  evmHookReader: EvmHookReader;
  evmIsmReader: EvmIsmReader;

  constructor(
    protected readonly multiProvider: MultiProvider,
    protected readonly chain: ChainNameOrId,
    protected readonly concurrency: number = DEFAULT_CONTRACT_READ_CONCURRENCY,
  ) {
    this.provider = this.multiProvider.getProvider(chain);
    this.evmHookReader = new EvmHookReader(multiProvider, chain, concurrency);
    this.evmIsmReader = new EvmIsmReader(multiProvider, chain, concurrency);
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
    const fetchedBaseMetadata = await this.fetchBaseMetadata(warpRouteAddress);
    const fetchedTokenMetadata = await this.fetchTokenMetadata(
      type,
      warpRouteAddress,
    );

    return {
      ...fetchedBaseMetadata,
      ...fetchedTokenMetadata,
      type,
    } as DerivedTokenRouterConfig;
  }

  /**
   * Derives the token type for a given Warp Route address using specific methods
   *
   * @param warpRouteAddress - The Warp Route address to derive the token type for.
   * @returns The derived token type, which can be one of: collateralVault, collateral, synthetic, or native.
   */
  async deriveTokenType(warpRouteAddress: Address): Promise<TokenType> {
    try {
      return Promise.any([
        this.isCollateralVault(warpRouteAddress),
        this.isCollateral(warpRouteAddress),
        this.isSynthetic(warpRouteAddress),
        this.isNative(warpRouteAddress),
      ]);
    } catch (e) {
      throw Error(
        `Error accessing token specific method, implying this is not a supported token.`,
      );
    }
  }

  /**
   * Checks if the given Warp Route address represents a collateral vault token.
   * It implies that the Warp Route has a `vault()` function.
   *
   * @param warpRouteAddress - The Warp Route address to check.
   * @returns `TokenType.collateralVault` if the Warp Route address represents a collateral vault token, otherwise throws an error.
   */
  async isCollateralVault(warpRouteAddress: Address): Promise<TokenType> {
    const collateralVault = HypERC20CollateralVaultDeposit__factory.connect(
      warpRouteAddress,
      this.provider,
    );
    await collateralVault.vault();
    return TokenType.collateralVault;
  }

  /**
   * Checks if the given Warp Route address represents a collateral token.
   * It implies that the Warp Route has a wrappedToken() function.
   *
   * @param warpRouteAddress - The Warp Route address to check.
   * @returns `TokenType.collateral` if the Warp Route address represents a collateral token, otherwise throws an error.
   */
  async isCollateral(warpRouteAddress: Address): Promise<TokenType> {
    const collateralVault = HypERC20Collateral__factory.connect(
      warpRouteAddress,
      this.provider,
    );
    await collateralVault.wrappedToken();
    return TokenType.collateral;
  }

  /**
   * Checks if the given Warp Route address represents a synthetic token.
   * It implies that the Warp Route has a decimals() function.
   *
   * @param warpRouteAddress - The Warp Route address to check.
   * @returns `TokenType.synthetic` if the Warp Route address represents a synthetic token, otherwise throws an error.
   */
  async isSynthetic(warpRouteAddress: Address): Promise<TokenType> {
    const collateralVault = HypERC20__factory.connect(
      warpRouteAddress,
      this.provider,
    );
    await collateralVault.decimals();
    return TokenType.synthetic;
  }

  /**
   * Checks if the given Warp Route address represents a native token.
   * It implies that the Warp Route has a receive() function
   *
   * @param warpRouteAddress - The Warp Route address to check.
   * @returns `TokenType.native` if the Warp Route address represents a native token, otherwise throws an error.
   */
  async isNative(warpRouteAddress: Address): Promise<TokenType> {
    await this.multiProvider.estimateGas(this.chain, {
      to: warpRouteAddress,
      from: await this.multiProvider.getSignerAddress(this.chain),
      value: BigNumber.from(1),
    });
    return TokenType.native;
  }

  /**
   * Fetches the base metadata for a Warp Route contract.
   *
   * @param routerAddress - The address of the Warp Route contract.
   * @returns The base metadata for the Warp Route contract, including the mailbox, owner, hook, and ism.
   */
  async fetchBaseMetadata(
    routerAddress: Address,
  ): Promise<WarpRouteBaseMetadata> {
    const warpRoute = HypERC20Collateral__factory.connect(
      routerAddress,
      this.provider,
    );
    const [mailbox, owner, hook, ism] = await Promise.all([
      warpRoute.mailbox(),
      warpRoute.owner(),
      warpRoute.hook(),
      warpRoute.interchainSecurityModule(),
    ]);

    const derivedIsm = eqAddress(ism, constants.AddressZero)
      ? undefined
      : await this.evmIsmReader.deriveIsmConfig(ism);
    const derivedHook = eqAddress(hook, constants.AddressZero)
      ? undefined
      : await this.evmHookReader.deriveHookConfig(hook);

    return {
      mailbox,
      owner,
      hook: derivedHook,
      interchainSecurityModule: derivedIsm,
    };
  }

  /**
   * Fetches the metadata for a token address.
   *
   * @param tokenAddress - The address of the token.
   * @returns A partial ERC20 metadata object containing the token name, symbol, total supply, and decimals.
   * Throws if unsupported token type
   */
  async fetchTokenMetadata(
    type: TokenType,
    tokenAddress: Address,
  ): Promise<TokenMetadata & { token?: string }> {
    if (type === TokenType.collateral || type === TokenType.collateralVault) {
      const erc20 = HypERC20Collateral__factory.connect(
        tokenAddress,
        this.provider,
      );
      const token = await erc20.wrappedToken();
      const { name, symbol, decimals, totalSupply } =
        await this.fetchERC20Metadata(token);

      return { name, symbol, decimals, totalSupply, token };
    } else if (type === TokenType.synthetic) {
      return this.fetchERC20Metadata(tokenAddress);
    } else if (type === TokenType.native) {
      const chainMetadata = this.multiProvider.getChainMetadata(this.chain);
      if (chainMetadata.nativeToken) {
        const { name, symbol, decimals } = chainMetadata.nativeToken;
        return { name, symbol, decimals, totalSupply: 0 };
      } else {
        throw new Error(
          `Warp route config specifies native token but chain metadata for ${this.chain} does not provide native token details`,
        );
      }
    } else {
      throw new Error(
        `Unsupported token type ${type} when fetching token metadata`,
      );
    }
  }

  async fetchERC20Metadata(tokenAddress: Address): Promise<TokenMetadata> {
    const erc20 = HypERC20__factory.connect(tokenAddress, this.provider);
    const [name, symbol, decimals, totalSupply] = await Promise.all([
      erc20.name(),
      erc20.symbol(),
      erc20.decimals(),
      erc20.totalSupply(),
    ]);

    return { name, symbol, decimals, totalSupply: totalSupply.toString() };
  }
}
