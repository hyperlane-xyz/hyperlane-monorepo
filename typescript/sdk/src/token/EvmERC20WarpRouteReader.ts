import { BigNumber, Contract } from 'ethers';

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
  OpL1NativeTokenBridge__factory,
  OpL2NativeTokenBridge__factory,
  PackageVersioned__factory,
  ProxyAdmin__factory,
  TokenBridgeCctp__factory,
  TokenRouter__factory,
} from '@hyperlane-xyz/core';
import { buildArtifact as coreBuildArtifact } from '@hyperlane-xyz/core/buildArtifact.js';
import {
  Address,
  assert,
  getLogLevel,
  isZeroishAddress,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { DEFAULT_CONTRACT_READ_CONCURRENCY } from '../consts/concurrency.js';
import { ContractVerifier } from '../deploy/verify/ContractVerifier.js';
import {
  ExplorerLicenseType,
  VerifyContractTypes,
} from '../deploy/verify/types.js';
import { EvmHookReader } from '../hook/EvmHookReader.js';
import { EvmIsmReader } from '../ism/EvmIsmReader.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { EvmRouterReader } from '../router/EvmRouterReader.js';
import { DestinationGas } from '../router/types.js';
import { ChainName, ChainNameOrId, DeployedOwnableConfig } from '../types.js';

import { isProxy, proxyAdmin, proxyImplementation } from './../deploy/proxy.js';
import { NON_ZERO_SENDER_ADDRESS, TokenType } from './config.js';
import {
  CctpTokenConfig,
  CollateralTokenConfig,
  DerivedTokenRouterConfig,
  HypTokenConfig,
  HypTokenConfigSchema,
  HypTokenRouterVirtualConfig,
  OpL1TokenConfig,
  OpL2TokenConfig,
  TokenMetadata,
  XERC20TokenMetadata,
} from './types.js';
import { getExtraLockBoxConfigs } from './xerc20.js';

export class EvmERC20WarpRouteReader extends EvmRouterReader {
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
  contractVerifier: ContractVerifier;

  constructor(
    protected readonly multiProvider: MultiProvider,
    protected readonly chain: ChainNameOrId,
    protected readonly concurrency: number = DEFAULT_CONTRACT_READ_CONCURRENCY,
    contractVerifier?: ContractVerifier,
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
      [TokenType.collateralCctp]:
        this.deriveHypCollateralCctpTokenConfig.bind(this),
      [TokenType.collateralVaultRebase]:
        this.deriveHypCollateralVaultRebaseTokenConfig.bind(this),
      [TokenType.native]: this.deriveHypNativeTokenConfig.bind(this),
      [TokenType.nativeOpL2]: this.deriveOpL2TokenConfig.bind(this),
      [TokenType.nativeOpL1]: this.deriveOpL1TokenConfig.bind(this),
      [TokenType.synthetic]: this.deriveHypSyntheticTokenConfig.bind(this),
      [TokenType.syntheticRebase]:
        this.deriveHypSyntheticRebaseConfig.bind(this),
      [TokenType.nativeScaled]: null,
      [TokenType.collateralUri]: null,
      [TokenType.syntheticUri]: null,
    };

    this.contractVerifier =
      contractVerifier ??
      new ContractVerifier(
        multiProvider,
        {},
        coreBuildArtifact,
        ExplorerLicenseType.MIT,
      );
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
    const tokenConfig = await this.fetchTokenConfig(type, warpRouteAddress);
    const routerConfig = await this.readRouterConfig(warpRouteAddress);
    // if the token has not been deployed as a proxy do not derive the config
    // inevm warp routes are an example
    const proxyAdmin = (await isProxy(this.provider, warpRouteAddress))
      ? await this.fetchProxyAdminConfig(warpRouteAddress)
      : undefined;
    const destinationGas = await this.fetchDestinationGas(warpRouteAddress);

    return {
      ...routerConfig,
      ...tokenConfig,
      proxyAdmin,
      destinationGas,
    };
  }

  async deriveWarpRouteVirtualConfig(
    chain: ChainName,
    address: Address,
  ): Promise<HypTokenRouterVirtualConfig> {
    const virtualConfig: HypTokenRouterVirtualConfig = {
      contractVerificationStatus: {},
    };

    const contractType = (await isProxy(this.provider, address))
      ? VerifyContractTypes.Proxy
      : VerifyContractTypes.Implementation;

    virtualConfig.contractVerificationStatus[contractType] =
      await this.contractVerifier.getContractVerificationStatus(chain, address);

    if (contractType === VerifyContractTypes.Proxy) {
      virtualConfig.contractVerificationStatus.Implementation =
        await this.contractVerifier.getContractVerificationStatus(
          chain,
          await proxyImplementation(this.provider, address),
        );

      // Derive ProxyAdmin status
      virtualConfig.contractVerificationStatus.ProxyAdmin =
        await this.contractVerifier.getContractVerificationStatus(
          chain,
          await proxyAdmin(this.provider, address),
        );
    }

    return virtualConfig;
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

    config.contractVersion = await this.fetchPackageVersion(warpRouteAddress);
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

  private async deriveHypCollateralCctpTokenConfig(
    hypToken: Address,
  ): Promise<CctpTokenConfig> {
    const collateralConfig =
      await this.deriveHypCollateralTokenConfig(hypToken);

    const tokenBridge = TokenBridgeCctp__factory.connect(
      hypToken,
      this.provider,
    );

    const messageTransmitter = await tokenBridge.messageTransmitter();
    const tokenMessenger = await tokenBridge.tokenMessenger();
    const urls = await tokenBridge.urls();

    return {
      ...collateralConfig,
      type: TokenType.collateralCctp,
      messageTransmitter,
      tokenMessenger,
      urls,
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

  private async deriveOpL2TokenConfig(
    _address: Address,
  ): Promise<OpL2TokenConfig> {
    const config = await this.deriveHypNativeTokenConfig(_address);

    const contract = OpL2NativeTokenBridge__factory.connect(
      _address,
      this.multiProvider.getProvider(this.chain),
    );

    const l2Bridge = await contract.l2Bridge();

    return {
      ...config,
      type: TokenType.nativeOpL2,
      l2Bridge,
    };
  }

  private async deriveOpL1TokenConfig(
    _address: Address,
  ): Promise<OpL1TokenConfig> {
    const config = await this.deriveHypNativeTokenConfig(_address);
    const contract = OpL1NativeTokenBridge__factory.connect(
      _address,
      this.multiProvider.getProvider(this.chain),
    );

    const urls = await contract.urls();
    const portal = await contract.opPortal();

    return {
      ...config,
      type: TokenType.nativeOpL1,
      urls,
      portal,
      // assume version 1 for now
      version: 1,
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

  async fetchPackageVersion(address: Address) {
    const contract = PackageVersioned__factory.connect(address, this.provider);
    return contract.PACKAGE_VERSION();
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
