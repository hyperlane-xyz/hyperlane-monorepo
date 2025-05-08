import { BigNumber, Contract, constants } from 'ethers';

import {
  HypERC20Collateral__factory,
  HypERC20__factory,
  HypERC4626Collateral__factory,
  HypERC4626OwnerCollateral__factory,
  HypERC4626__factory,
  HypXERC20Lockbox__factory,
  HypXERC20__factory,
  IFiatToken__factory,
  IXERC20__factory,
  ProxyAdmin__factory,
  TokenRouter__factory,
} from '@hyperlane-xyz/core';
import {
  Address,
  assert,
  eqAddress,
  getLogLevel,
  isZeroishAddress,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { DEFAULT_CONTRACT_READ_CONCURRENCY } from '../consts/concurrency.js';
import { EvmHookReader } from '../hook/EvmHookReader.js';
import { EvmIsmReader } from '../ism/EvmIsmReader.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import {
  DerivedMailboxClientConfig,
  DestinationGas,
  RemoteRouters,
  RemoteRoutersSchema,
} from '../router/types.js';
import { ChainNameOrId, DeployedOwnableConfig } from '../types.js';
import { HyperlaneReader } from '../utils/HyperlaneReader.js';

import { isProxy, proxyAdmin } from './../deploy/proxy.js';
import { NON_ZERO_SENDER_ADDRESS, TokenType } from './config.js';
import {
  CollateralTokenConfig,
  DerivedTokenRouterConfig,
  HypTokenConfig,
  HypTokenConfigSchema,
  TokenMetadata,
  XERC20TokenMetadata,
} from './types.js';
import { getExtraLockBoxConfigs } from './xerc20.js';

export class EvmERC20WarpRouteReader extends HyperlaneReader {
  protected readonly logger = rootLogger.child({
    module: 'EvmERC20WarpRouteReader',
  });

  // Using null instead of undefined to force
  // a compile error when adding a new token type
  protected readonly deriveTokenConfigMap: Record<
    TokenType,
    ((address: Address) => Promise<HypTokenConfig>) | null
  >;
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

    this.deriveTokenConfigMap = {
      [TokenType.XERC20]: this.deriveHypXERC20TokenConfig.bind(this),
      [TokenType.XERC20Lockbox]:
        this.deriveHypXERC20LockboxTokenConfig.bind(this),
      [TokenType.collateral]: this.deriveHypCollateralTokenConfig.bind(this),
      [TokenType.collateralFiat]:
        this.deriveHypCollateralFiatTokenConfig.bind(this),
      [TokenType.collateralVault]:
        this.deriveHypCollateralVaultTokenConfig.bind(this),
      [TokenType.collateralVaultRebase]:
        this.deriveHypCollateralVaultRebaseTokenConfig.bind(this),
      [TokenType.native]: this.deriveHypNativeTokenConfig.bind(this),
      [TokenType.synthetic]: this.deriveHypSyntheticTokenConfig.bind(this),
      [TokenType.syntheticRebase]:
        this.deriveHypSyntheticRebaseConfig.bind(this),
      [TokenType.nativeScaled]: null,
      [TokenType.collateralUri]: null,
      [TokenType.syntheticUri]: null,
    };
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
    const mailboxClientConfig =
      await this.fetchMailboxClientConfig(warpRouteAddress);
    const tokenConfig = await this.fetchTokenConfig(type, warpRouteAddress);
    const remoteRouters = await this.fetchRemoteRouters(warpRouteAddress);
    // if the token has not been deployed as a proxy do not derive the config
    // inevm warp routes are an example
    const proxyAdmin = (await isProxy(this.provider, warpRouteAddress))
      ? await this.fetchProxyAdminConfig(warpRouteAddress)
      : undefined;
    const destinationGas = await this.fetchDestinationGas(warpRouteAddress);

    return {
      ...mailboxClientConfig,
      ...tokenConfig,
      remoteRouters,
      proxyAdmin,
      destinationGas,
    };
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
      [TokenType.collateralVaultRebase]: {
        factory: HypERC4626Collateral__factory,
        method: 'NULL_RECIPIENT',
      },
      [TokenType.collateralVault]: {
        factory: HypERC4626OwnerCollateral__factory,
        method: 'vault',
      },
      [TokenType.XERC20Lockbox]: {
        factory: HypXERC20Lockbox__factory,
        method: 'lockbox',
      },
      [TokenType.collateral]: {
        factory: HypERC20Collateral__factory,
        method: 'wrappedToken',
      },
      [TokenType.syntheticRebase]: {
        factory: HypERC4626__factory,
        method: 'collateralDomain',
      },
      [TokenType.synthetic]: {
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
        if (tokenType === TokenType.collateral) {
          const wrappedToken = await warpRoute.wrappedToken();
          try {
            const xerc20 = IXERC20__factory.connect(
              wrappedToken,
              this.provider,
            );
            await xerc20['mintingCurrentLimitOf(address)'](warpRouteAddress);
            return TokenType.XERC20;
          } catch (error) {
            this.logger.debug(
              `Warp route token at address "${warpRouteAddress}" on chain "${this.chain}" is not a ${TokenType.XERC20}`,
              error,
            );
          }

          try {
            const fiatToken = IFiatToken__factory.connect(
              wrappedToken,
              this.provider,
            );

            // Simulate minting tokens from the warp route contract
            await fiatToken.callStatic.mint(NON_ZERO_SENDER_ADDRESS, 1, {
              from: warpRouteAddress,
            });

            return TokenType.collateralFiat;
          } catch (error) {
            this.logger.debug(
              `Warp route token at address "${warpRouteAddress}" on chain "${this.chain}" is not a ${TokenType.collateralFiat}`,
              error,
            );
          }
        }
        return tokenType as TokenType;
      } catch {
        continue;
      } finally {
        this.setSmartProviderLogLevel(getLogLevel()); // returns to original level defined by rootLogger
      }
    }

    // Finally check native
    // Using estimateGas to send 0 wei. Success implies that the Warp Route has a receive() function
    try {
      await this.multiProvider.estimateGas(
        this.chain,
        {
          to: warpRouteAddress,
          value: BigNumber.from(0),
        },
        NON_ZERO_SENDER_ADDRESS, // Use non-zero address as signer is not provided for read commands
      );
      return TokenType.native;
    } catch (e) {
      throw Error(`Error accessing token specific method ${e}`);
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
  ): Promise<DerivedMailboxClientConfig> {
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
    const deriveFunction = this.deriveTokenConfigMap[type];
    if (!deriveFunction) {
      throw new Error(
        `Provided unsupported token type "${type}" when fetching token metadata on chain "${this.chain}" at address "${warpRouteAddress}"`,
      );
    }

    const config = await deriveFunction(warpRouteAddress);
    return HypTokenConfigSchema.parse(config);
  }

  private async deriveHypXERC20TokenConfig(
    hypTokenAddress: Address,
  ): Promise<HypTokenConfig> {
    const hypXERC20TokenInstance = HypXERC20__factory.connect(
      hypTokenAddress,
      this.provider,
    );

    const collateralTokenAddress = await hypXERC20TokenInstance.wrappedToken();
    const [erc20TokenMetadata, xERC20Metadata] = await Promise.all([
      this.fetchERC20Metadata(collateralTokenAddress),
      this.fetchXERC20Config(collateralTokenAddress, hypTokenAddress),
    ]);

    return {
      ...erc20TokenMetadata,
      type: TokenType.XERC20,
      token: collateralTokenAddress,
      xERC20: xERC20Metadata.xERC20,
    };
  }

  private async deriveHypXERC20LockboxTokenConfig(
    hypTokenAddress: Address,
  ): Promise<HypTokenConfig> {
    const hypXERC20TokenLockboxTokenInstance =
      HypXERC20Lockbox__factory.connect(hypTokenAddress, this.provider);

    const xerc20TokenAddress =
      await hypXERC20TokenLockboxTokenInstance.xERC20();
    const [erc20TokenMetadata, xERC20Metadata, lockbox] = await Promise.all([
      this.fetchERC20Metadata(xerc20TokenAddress),
      this.fetchXERC20Config(xerc20TokenAddress, hypTokenAddress),
      hypXERC20TokenLockboxTokenInstance.lockbox(),
    ]);

    return {
      ...erc20TokenMetadata,
      type: TokenType.XERC20Lockbox,
      token: lockbox,
      xERC20: xERC20Metadata.xERC20,
    };
  }

  private async deriveHypCollateralTokenConfig(
    hypToken: Address,
  ): Promise<CollateralTokenConfig> {
    const hypCollateralTokenInstance = HypERC20Collateral__factory.connect(
      hypToken,
      this.provider,
    );

    const collateralTokenAddress =
      await hypCollateralTokenInstance.wrappedToken();
    const erc20TokenMetadata = await this.fetchERC20Metadata(
      collateralTokenAddress,
    );

    return {
      ...erc20TokenMetadata,
      type: TokenType.collateral,
      token: collateralTokenAddress,
    };
  }

  private async deriveHypCollateralFiatTokenConfig(
    hypToken: Address,
  ): Promise<HypTokenConfig> {
    const erc20TokenMetadata =
      await this.deriveHypCollateralTokenConfig(hypToken);

    return {
      ...erc20TokenMetadata,
      type: TokenType.collateralFiat,
    };
  }

  private async deriveHypCollateralVaultTokenConfig(
    hypToken: Address,
  ): Promise<HypTokenConfig> {
    const erc20TokenMetadata =
      await this.deriveHypCollateralTokenConfig(hypToken);

    return {
      ...erc20TokenMetadata,
      type: TokenType.collateralVault,
    };
  }

  private async deriveHypCollateralVaultRebaseTokenConfig(
    hypToken: Address,
  ): Promise<HypTokenConfig> {
    const erc20TokenMetadata =
      await this.deriveHypCollateralTokenConfig(hypToken);

    return {
      ...erc20TokenMetadata,
      type: TokenType.collateralVaultRebase,
    };
  }

  private async deriveHypSyntheticTokenConfig(
    hypTokenAddress: Address,
  ): Promise<HypTokenConfig> {
    const erc20TokenMetadata = await this.fetchERC20Metadata(hypTokenAddress);

    return {
      ...erc20TokenMetadata,
      type: TokenType.synthetic,
    };
  }

  private async deriveHypNativeTokenConfig(
    _address: Address,
  ): Promise<HypTokenConfig> {
    const chainMetadata = this.multiProvider.getChainMetadata(this.chain);
    if (!chainMetadata.nativeToken) {
      throw new Error(
        `Warp route config specifies native token but chain metadata for chain "${this.chain}" does not provide native token details`,
      );
    }

    const { name, symbol, decimals } = chainMetadata.nativeToken;
    return {
      type: TokenType.native,
      name,
      symbol,
      decimals,
      isNft: false,
    };
  }

  private async deriveHypSyntheticRebaseConfig(
    hypTokenAddress: Address,
  ): Promise<HypTokenConfig> {
    const hypERC4626 = HypERC4626__factory.connect(
      hypTokenAddress,
      this.provider,
    );

    const [erc20TokenMetadata, collateralDomainId] = await Promise.all([
      this.fetchERC20Metadata(hypTokenAddress),
      hypERC4626.collateralDomain(),
    ]);

    const collateralChainName =
      this.multiProvider.getChainName(collateralDomainId);

    return {
      ...erc20TokenMetadata,
      type: TokenType.syntheticRebase,
      collateralChainName,
    };
  }

  async fetchERC20Metadata(tokenAddress: Address): Promise<TokenMetadata> {
    const erc20 = HypERC20__factory.connect(tokenAddress, this.provider);
    const [name, symbol, decimals] = await Promise.all([
      erc20.name(),
      erc20.symbol(),
      erc20.decimals(),
    ]);

    return { name, symbol, decimals, isNft: false };
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
          return [domain, { address: await warpRoute.routers(domain) }];
        }),
      ),
    );

    return RemoteRoutersSchema.parse(routers);
  }

  async fetchProxyAdminConfig(
    tokenAddress: Address,
  ): Promise<DeployedOwnableConfig> {
    const proxyAdminAddress = await proxyAdmin(this.provider, tokenAddress);
    assert(
      !isZeroishAddress(proxyAdminAddress),
      `ProxyAdmin config for warp token at address "${tokenAddress}" can't be derived because it is not a proxy.`,
    );

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
