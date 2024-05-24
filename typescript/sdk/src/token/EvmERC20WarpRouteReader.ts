import { ethers, providers } from 'ethers';

import {
  HypERC20CollateralVaultDeposit__factory,
  HypERC20Collateral__factory,
  HypERC20__factory,
} from '@hyperlane-xyz/core';
import {
  ERC20Metadata,
  IsmType,
  TokenRouterConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';
import { Address, isZeroishAddress, rootLogger } from '@hyperlane-xyz/utils';

import { DEFAULT_CONTRACT_READ_CONCURRENCY } from '../consts/concurrency.js';
import { EvmHookReader } from '../hook/EvmHookReader.js';
import {
  DerivedIsmConfigWithAddress,
  EvmIsmReader,
} from '../ism/EvmIsmReader.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { ChainNameOrId } from '../types.js';

type WarpRouteBaseMetadata = Record<'mailbox' | 'owner' | 'hook', string> & {
  interchainSecurityModule?: DerivedIsmConfigWithAddress;
};

/**
 * @remark
 * We only expect to support deriving a subset of these types, for now.
 */
export type DerivedTokenType = Extract<
  TokenType,
  'collateral' | 'collateralVault' | 'native' | 'synthetic'
>;

export type DerivedTokenRouterConfig = TokenRouterConfig & {
  interchainSecurityModule?: DerivedIsmConfigWithAddress;
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
   * @returns The derived token type, which can be one of: collateralVault, collateral, native, or synthetic.
   */
  async deriveTokenType(warpRouteAddress: Address): Promise<DerivedTokenType> {
    const contractTypes: Record<
      Exclude<DerivedTokenType, 'native'>, // native is excluded because it's the default return type
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
        const warpRoute = factory.connect(warpRouteAddress, this.provider);
        await warpRoute[method]();
        return type as DerivedTokenType;
      } catch (e) {
        this.logger.info(
          `Error accessing token specific method, ${method}, implying this is not a ${type} token.`,
          warpRouteAddress,
        );
      }
    }

    this.logger.info(
      `No matching token specific method. Defaulting to ${TokenType.native}.`,
      warpRouteAddress,
    );
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
    const [mailbox, owner, hook, interchainSecurityModule] = await Promise.all([
      warpRoute.mailbox(),
      warpRoute.owner(),
      warpRoute.hook(),
      warpRoute.interchainSecurityModule(),
    ]);

    const metadata: WarpRouteBaseMetadata = {
      mailbox,
      owner,
      hook,
    };

    // If ISM is unset, then Address Zero will be returned
    isZeroishAddress(interchainSecurityModule)
      ? (metadata.interchainSecurityModule = {
          type: IsmType.CUSTOM,
          address: ethers.constants.AddressZero,
        })
      : (metadata.interchainSecurityModule =
          await this.evmIsmReader.deriveIsmConfig(interchainSecurityModule));

    // @todo add after https://github.com/hyperlane-xyz/hyperlane-monorepo/issues/3667 is fixed
    // isZeroishAddress(interchainSecurityModule)
    //   ? (metadata.hook = {
    //       type: IsmType.ADDRESS,
    //       address: ethers.constants.AddressZero,
    //     })
    //   : (metadata.hook =
    //       await this.evmIsmReader.deriveHookConfig(hook));

    return metadata;
  }

  /**
   * Fetches the metadata for a token address.
   *
   * @param tokenAddress - The address of the token.
   * @returns A partial ERC20 metadata object containing the token name, symbol, total supply, and decimals.
   */
  async fetchTokenMetadata(
    type: TokenType,
    tokenAddress: Address,
  ): Promise<ERC20Metadata & { token?: string }> {
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
    } else {
      // Assumes Native
      const chainMetadata = this.multiProvider.getChainMetadata(this.chain);
      if (chainMetadata.nativeToken) {
        const { name, symbol, decimals } = chainMetadata.nativeToken;
        return { name, symbol, decimals, totalSupply: 0 };
      } else {
        throw new Error(
          `Warp route config specifies native token but chain metadata for ${this.chain} does not provide native token details`,
        );
      }
    }
  }

  async fetchERC20Metadata(tokenAddress: Address): Promise<ERC20Metadata> {
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
