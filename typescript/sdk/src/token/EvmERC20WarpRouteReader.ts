import { BigNumber, constants } from 'ethers';

import {
  HypERC20Collateral__factory,
  HypERC20__factory,
  HypERC4626Collateral__factory,
  TokenRouter__factory,
} from '@hyperlane-xyz/core';
import {
  MailboxClientConfig,
  TokenRouterConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';
import {
  Address,
  bytes32ToAddress,
  eqAddress,
  getLogLevel,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { DEFAULT_CONTRACT_READ_CONCURRENCY } from '../consts/concurrency.js';
import { EvmHookReader } from '../hook/EvmHookReader.js';
import { EvmIsmReader } from '../ism/EvmIsmReader.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { RemoteRouters } from '../router/types.js';
import { ChainNameOrId } from '../types.js';
import { HyperlaneReader } from '../utils/HyperlaneReader.js';

import { CollateralExtensions } from './config.js';
import { TokenMetadata } from './types.js';

export class EvmERC20WarpRouteReader extends HyperlaneReader {
  protected readonly logger = rootLogger.child({
    module: 'EvmERC20WarpRouteReader',
  });
  evmHookReader: EvmHookReader;
  evmIsmReader: EvmIsmReader;

  constructor(
    protected readonly multiProvider: MultiProvider,
    protected readonly chain: ChainNameOrId,
    protected readonly concurrency: number = DEFAULT_CONTRACT_READ_CONCURRENCY,
  ) {
    super(multiProvider, chain);
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
  ): Promise<TokenRouterConfig> {
    // Derive the config type
    const type = await this.deriveTokenType(warpRouteAddress);
    const baseMetadata = await this.fetchMailboxClientConfig(warpRouteAddress);
    const tokenMetadata = await this.fetchTokenMetadata(type, warpRouteAddress);
    const remoteRouters = await this.fetchRemoteRouters(warpRouteAddress);

    return {
      ...baseMetadata,
      ...tokenMetadata,
      remoteRouters,
      type,
    } as TokenRouterConfig;
  }

  /**
   * Derives the token type for a given Warp Route address using specific methods
   *
   * @param warpRouteAddress - The Warp Route address to derive the token type for.
   * @returns The derived token type, which can be one of: collateralVault, collateral, native, or synthetic.
   */
  async deriveTokenType(warpRouteAddress: Address): Promise<TokenType> {
    const contractTypes: Partial<
      Record<TokenType, { factory: any; method: string }>
    > = {
      collateralVault: {
        factory: HypERC4626Collateral__factory,
        method: 'vault',
      },
      collateral: {
        factory: HypERC20Collateral__factory,
        method: 'wrappedToken',
      },
      synthetic: {
        factory: HypERC20__factory,
        method: 'decimals',
      },
    };

    // Temporarily turn off SmartProvider logging
    // Provider errors are expected because deriving will call methods that may not exist in the Bytecode
    this.setSmartProviderLogLevel('silent');

    // First, try checking token specific methods
    for (const [tokenType, { factory, method }] of Object.entries(
      contractTypes,
    )) {
      try {
        const warpRoute = factory.connect(warpRouteAddress, this.provider);
        await warpRoute[method]();

        this.setSmartProviderLogLevel(getLogLevel()); // returns to original level defined by rootLogger
        return tokenType as TokenType;
      } catch (e) {
        continue;
      }
    }

    // Finally check native
    // Using estimateGas to send 0 wei. Success implies that the Warp Route has a receive() function
    try {
      await this.multiProvider.estimateGas(this.chain, {
        to: warpRouteAddress,
        from: await this.multiProvider.getSignerAddress(this.chain),
        value: BigNumber.from(0),
      });
      return TokenType.native;
    } catch (e) {
      throw Error(
        `Error accessing token specific method, implying this is not a supported token.`,
      );
    } finally {
      this.setSmartProviderLogLevel(getLogLevel()); // returns to original level defined by rootLogger
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
    if (CollateralExtensions.includes(type)) {
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

  async fetchRemoteRouters(warpRouteAddress: Address): Promise<RemoteRouters> {
    const warpRoute = TokenRouter__factory.connect(
      warpRouteAddress,
      this.provider,
    );
    const domains = await warpRoute.domains();

    return Object.fromEntries(
      await Promise.all(
        domains.map(async (domain) => {
          return [domain, bytes32ToAddress(await warpRoute.routers(domain))];
        }),
      ),
    );
  }
}
