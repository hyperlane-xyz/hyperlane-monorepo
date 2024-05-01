import { ethers, providers } from 'ethers';

import {
  ERC20__factory,
  HypERC20CollateralVaultDeposit__factory,
  HypERC20Collateral__factory,
  HypERC20__factory,
} from '@hyperlane-xyz/core';
import {
  ERC20Metadata,
  TokenRouterConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';
import { Address, rootLogger } from '@hyperlane-xyz/utils';

import { DEFAULT_CONTRACT_READ_CONCURRENCY } from '../consts/crud.js';
import { EvmHookReader } from '../hook/read.js';
import { DerivedIsmConfigWithAddress, EvmIsmReader } from '../ism/read.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { ChainNameOrId } from '../types.js';

type WarpRouteBaseMetadata = Record<
  'mailbox' | 'owner' | 'token' | 'hook' | 'interchainSecurityModule',
  string
>;

/**
 * @remark
 * We only expect to support deriving a subset of these types, for now.
 */
export type DerivedTokenType = Extract<
  TokenType,
  'collateral' | 'collateralVault' | 'native' | 'synthetic'
>;

export type DerivedTokenRouter = Exclude<
  TokenRouterConfig,
  'interchainSecurityModule' | 'type'
> & {
  type: DerivedTokenType;
  interchainSecurityModule: DerivedIsmConfigWithAddress;
}; // ISM is not optional because address(0) is always returned

export class EvmERC20WarpRouteReader {
  protected readonly logger = rootLogger.child({ module: 'EvmIsmReader' });
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
   * @param address - The address of the Hyperlane ERC20 router contract.
   * @returns The configuration for the Hyperlane ERC20 router.
   *
   */
  async deriveWarpRouteConfig(address: Address): Promise<DerivedTokenRouter> {
    const fetchedBaseMetadata = await this.fetchBaseMetadata(address);
    const fetchedTokenMetadata = await this.fetchTokenMetadata(
      fetchedBaseMetadata.token,
    );

    // Derive the config type
    const type = await this.deriveTokenType(address);

    // @TODO figure out why this typing doesn't work
    const results: DerivedTokenRouter = {
      ...fetchedBaseMetadata,
      ...fetchedTokenMetadata,
      type,
    };

    if (
      fetchedBaseMetadata.interchainSecurityModule !==
      ethers.constants.AddressZero
    ) {
      results.interchainSecurityModule =
        await this.evmIsmReader.deriveIsmConfig(
          fetchedBaseMetadata.interchainSecurityModule,
        );
    }
    // @todo add after https://github.com/hyperlane-xyz/hyperlane-monorepo/issues/3667 is fixed
    // if (fetchedBaseMetadata.hook !== ethers.constants.AddressZero) {
    //   results.hook = await this.evmHookReader.deriveHookConfig(
    //     fetchedBaseMetadata.hook,
    //   );
    // }

    return results;
  }

  /**
   * Derives the token type for a given Warp Route address using specific methods
   *
   * @param address - The Warp Route address to derive the token type for.
   * @returns The derived token type, which can be one of: collateralVault, collateral, native, or synthetic.
   */
  async deriveTokenType(address: Address): Promise<DerivedTokenType> {
    const contractTypes: Record<
      Exclude<DerivedTokenType, 'native'>,
      { factory: any; method: string }
    > = {
      collateral: {
        factory: HypERC20Collateral__factory,
        method: 'wrappedToken',
      },
      collateralVault: {
        factory: HypERC20CollateralVaultDeposit__factory,
        method: 'vault',
      },
      synthetic: {
        factory: HypERC20__factory,
        method: 'decimals',
      },
    };

    for (const [type, { factory, method }] of Object.entries(contractTypes)) {
      try {
        const warpRoute = factory.connect(address, this.provider);
        await warpRoute[method]();
        return type as DerivedTokenType;
      } catch (e) {
        this.logger.debug(
          `Error accessing token specific property, implying this is not a ${type} token. Defaulting to ${TokenType.native}.`,
          address,
        );
      }
    }

    return TokenType.native;
  }

  /**
   * Fetches the base metadata for a Warp Route contract.
   *
   * @param routerAddress - The address of the Warp Route contract.
   * @returns The base metadata for the Warp Route contract, including the mailbox, owner, wrapped token address, hook, and interchain security module.
   */
  async fetchBaseMetadata(
    routerAddress: Address,
  ): Promise<WarpRouteBaseMetadata> {
    const warpRoute = HypERC20Collateral__factory.connect(
      routerAddress,
      this.provider,
    );
    const [mailbox, owner, token, hook, interchainSecurityModule] =
      await Promise.all([
        warpRoute.mailbox(),
        warpRoute.owner(),
        warpRoute.wrappedToken(),
        warpRoute.hook(),
        warpRoute.interchainSecurityModule(),
      ]);

    return {
      mailbox,
      owner,
      token,
      hook,
      interchainSecurityModule,
    };
  }

  /**
   * Fetches the metadata for a token address.
   *
   * @param tokenAddress - The address of the token.
   * @returns A partial ERC20 metadata object containing the token name, symbol, total supply, and decimals.
   */
  async fetchTokenMetadata(tokenAddress: Address): Promise<ERC20Metadata> {
    const erc20 = ERC20__factory.connect(tokenAddress, this.provider);
    const [name, symbol, totalSupply, decimals] = await Promise.all([
      erc20.name(),
      erc20.symbol(),
      erc20.totalSupply().toString(),
      erc20.decimals(),
    ]);

    return { name, symbol, totalSupply, decimals };
  }
}
