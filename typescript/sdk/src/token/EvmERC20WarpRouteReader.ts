import { BigNumber, Contract, constants } from 'ethers';

import {
  HypERC20Collateral__factory,
  HypERC20__factory,
  HypERC4626Collateral__factory,
  HypERC4626OwnerCollateral__factory,
  HypERC4626__factory,
  HypXERC20Lockbox__factory,
  IXERC20__factory,
  ProxyAdmin__factory,
  TokenRouter__factory,
} from '@hyperlane-xyz/core';
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
import {
  DestinationGas,
  MailboxClientConfig,
  RemoteRouters,
  RemoteRoutersSchema,
} from '../router/types.js';
import { ChainNameOrId, DeployedOwnableConfig } from '../types.js';
import { HyperlaneReader } from '../utils/HyperlaneReader.js';

import { proxyAdmin } from './../deploy/proxy.js';
import { NON_ZERO_SENDER_ADDRESS, TokenType } from './config.js';
import {
  HypTokenConfig,
  HypTokenRouterConfig,
  TokenMetadata,
  XERC20TokenMetadata,
} from './types.js';
import { getExtraLockBoxConfigs } from './xerc20.js';

export class EvmERC20WarpRouteReader extends HyperlaneReader {
  protected readonly logger = rootLogger.child({
    module: 'EvmERC20WarpRouteReader',
  });
  evmHookReader: EvmHookReader;
  evmIsmReader: EvmIsmReader;

  private static tokenTypeCache: Map<Address, TokenType> = new Map();

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
  ): Promise<HypTokenRouterConfig> {
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
    } as HypTokenRouterConfig;
  }

  /**
   * Derives the token type for a given Warp Route address using specific methods
   *
   * @param warpRouteAddress - The Warp Route address to derive the token type for.
   * @returns The derived token type, which can be one of: collateralVault, collateral, native, or synthetic.
   */
  async deriveTokenType(warpRouteAddress: Address): Promise<TokenType> {
    const cached = EvmERC20WarpRouteReader.tokenTypeCache.get(warpRouteAddress);
    if (cached) return cached;

    // Temporarily turn off SmartProvider logging
    // Provider errors are expected because deriving will call methods that may not exist in the Bytecode
    this.setSmartProviderLogLevel('silent');

    try {
      const contracts: Partial<Record<TokenType, any>> = {
        [TokenType.collateralVaultRebase]:
          HypERC4626Collateral__factory.connect(
            warpRouteAddress,
            this.provider,
          ),
        [TokenType.collateralVault]: HypERC4626OwnerCollateral__factory.connect(
          warpRouteAddress,
          this.provider,
        ),
        [TokenType.XERC20Lockbox]: HypXERC20Lockbox__factory.connect(
          warpRouteAddress,
          this.provider,
        ),
        [TokenType.collateral]: HypERC20Collateral__factory.connect(
          warpRouteAddress,
          this.provider,
        ),
        [TokenType.syntheticRebase]: HypERC4626__factory.connect(
          warpRouteAddress,
          this.provider,
        ),
        [TokenType.synthetic]: HypERC20__factory.connect(
          warpRouteAddress,
          this.provider,
        ),
      };

      // Batch all method calls together
      const results = await Promise.allSettled([
        contracts[TokenType.collateralVaultRebase]
          .NULL_RECIPIENT()
          .then(() => TokenType.collateralVaultRebase),
        contracts[TokenType.collateralVault]
          .vault()
          .then(() => TokenType.collateralVault),
        contracts[TokenType.XERC20Lockbox]
          .lockbox()
          .then(() => TokenType.XERC20Lockbox),
        contracts[TokenType.collateral]
          .wrappedToken()
          .then(async (wrappedToken: Address) => {
            try {
              const xerc20 = IXERC20__factory.connect(
                wrappedToken,
                this.provider,
              );
              await xerc20['mintingCurrentLimitOf(address)'](warpRouteAddress);
              return TokenType.XERC20;
            } catch {
              return TokenType.collateral;
            }
          }),
        contracts[TokenType.syntheticRebase]
          .collateralDomain()
          .then(() => TokenType.syntheticRebase),
        contracts[TokenType.synthetic]
          .decimals()
          .then(() => TokenType.synthetic),
      ]);

      // Find the first successful result and cache it
      for (const result of results) {
        if (result.status === 'fulfilled') {
          const tokenType = result.value;
          EvmERC20WarpRouteReader.tokenTypeCache.set(
            warpRouteAddress,
            tokenType,
          );
          return tokenType;
        }
      }

      // Check native last (only if all others fail)
      try {
        await this.multiProvider.estimateGas(
          this.chain,
          {
            to: warpRouteAddress,
            value: BigNumber.from(0),
          },
          NON_ZERO_SENDER_ADDRESS, // Use non-zero address as signer is not provided for read commands
        );
        const type = TokenType.native;
        EvmERC20WarpRouteReader.tokenTypeCache.set(warpRouteAddress, type);
        return type;
      } catch (e) {
        throw Error(`Unable to determine token type: ${e}`);
      }
    } finally {
      this.setSmartProviderLogLevel(getLogLevel());
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
      ? constants.AddressZero
      : await this.evmIsmReader.deriveIsmConfig(ism);
    const derivedHook = eqAddress(hook, constants.AddressZero)
      ? constants.AddressZero
      : await this.evmHookReader.deriveHookConfig(hook);

    return {
      mailbox,
      owner,
      hook: derivedHook,
      interchainSecurityModule: derivedIsm,
    };
  }

  async fetchXERC20Config(
    xERC20Address: Address,
    warpRouteAddress: Address,
  ): Promise<XERC20TokenMetadata> {
    // fetch the limits if possible
    const rateLimitsABI = [
      'function rateLimitPerSecond(address) external view returns (uint128)',
      'function bufferCap(address) external view returns (uint112)',
    ];
    const xERC20 = new Contract(xERC20Address, rateLimitsABI, this.provider);

    try {
      const extraBridgesLimits = await getExtraLockBoxConfigs({
        chain: this.chain,
        multiProvider: this.multiProvider,
        xERC20Address,
        logger: this.logger,
      });

      return {
        xERC20: {
          warpRouteLimits: {
            rateLimitPerSecond: (
              await xERC20.rateLimitPerSecond(warpRouteAddress)
            ).toString(),
            bufferCap: (await xERC20.bufferCap(warpRouteAddress)).toString(),
          },
          extraBridges:
            extraBridgesLimits.length > 0 ? extraBridgesLimits : undefined,
        },
      };
    } catch (error) {
      this.logger.error(
        `Error fetching xERC20 limits for token at ${xERC20Address} on chain ${this.chain}`,
        error,
      );
      return {};
    }
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
    if (
      type === TokenType.collateral ||
      type === TokenType.collateralVault ||
      type === TokenType.collateralVaultRebase ||
      type === TokenType.XERC20 ||
      type === TokenType.XERC20Lockbox
    ) {
      let xerc20Token: Address | undefined;
      let lockbox: Address | undefined;
      let token: Address;
      let xERC20Metadata: XERC20TokenMetadata | {} = {};

      if (type === TokenType.XERC20Lockbox) {
        // XERC20Lockbox is a special case of collateral, we will fetch it from the xerc20 contract
        const hypXERC20Lockbox = HypXERC20Lockbox__factory.connect(
          warpRouteAddress,
          this.provider,
        );
        xerc20Token = await hypXERC20Lockbox.xERC20();
        token = xerc20Token;
        lockbox = await hypXERC20Lockbox.lockbox();
      } else {
        const erc20 = HypERC20Collateral__factory.connect(
          warpRouteAddress,
          this.provider,
        );
        token = await erc20.wrappedToken();
      }

      const { name, symbol, decimals } = await this.fetchERC20Metadata(token);

      if (type === TokenType.XERC20 || type === TokenType.XERC20Lockbox) {
        xERC20Metadata = await this.fetchXERC20Config(token, warpRouteAddress);
      }

      return {
        ...xERC20Metadata,
        type,
        name,
        symbol,
        decimals,
        token: lockbox || token,
      };
    } else if (
      type === TokenType.synthetic ||
      type === TokenType.syntheticRebase
    ) {
      const baseMetadata = await this.fetchERC20Metadata(warpRouteAddress);

      if (type === TokenType.syntheticRebase) {
        const hypERC4626 = HypERC4626__factory.connect(
          warpRouteAddress,
          this.provider,
        );
        const collateralChainName = this.multiProvider.getChainName(
          await hypERC4626.collateralDomain(),
        );
        return { type, ...baseMetadata, collateralChainName };
      }

      return { type, ...baseMetadata };
    } else if (type === TokenType.native) {
      const chainMetadata = this.multiProvider.getChainMetadata(this.chain);
      if (chainMetadata.nativeToken) {
        const { name, symbol, decimals } = chainMetadata.nativeToken;
        return {
          type,
          name,
          symbol,
          decimals,
        };
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
    const [name, symbol, decimals] = await Promise.all([
      erc20.name(),
      erc20.symbol(),
      erc20.decimals(),
    ]);

    return { name, symbol, decimals };
  }

  async fetchRemoteRouters(warpRouteAddress: Address): Promise<RemoteRouters> {
    const warpRoute = TokenRouter__factory.connect(
      warpRouteAddress,
      this.provider,
    );
    const domains = await warpRoute.domains();

    const routers = Object.fromEntries(
      await Promise.all(
        domains.map(async (domain) => {
          return [
            domain,
            { address: bytes32ToAddress(await warpRoute.routers(domain)) },
          ];
        }),
      ),
    );

    return RemoteRoutersSchema.parse(routers);
  }

  async fetchProxyAdminConfig(
    tokenAddress: Address,
  ): Promise<DeployedOwnableConfig> {
    const proxyAdminAddress = await proxyAdmin(this.provider, tokenAddress);
    const proxyAdminInstance = ProxyAdmin__factory.connect(
      proxyAdminAddress,
      this.provider,
    );

    return {
      address: proxyAdminAddress,
      owner: await proxyAdminInstance.owner(),
    };
  }

  async fetchDestinationGas(
    warpRouteAddress: Address,
  ): Promise<DestinationGas> {
    const warpRoute = TokenRouter__factory.connect(
      warpRouteAddress,
      this.provider,
    );

    /**
     * @remark
     * Router.domains() is used to enumerate the destination gas because GasRouter.destinationGas is not EnumerableMapExtended type
     * This means that if a domain is removed, then we cannot read the destinationGas for it. This may impact updates.
     */
    const domains = await warpRoute.domains();

    return Object.fromEntries(
      await Promise.all(
        domains.map(async (domain) => {
          return [domain, (await warpRoute.destinationGas(domain)).toString()];
        }),
      ),
    );
  }
}
