import { compareVersions } from 'compare-versions';
import { BigNumber, Contract, constants } from 'ethers';

import {
  EverclearTokenBridge,
  EverclearTokenBridge__factory,
  HypERC20Collateral__factory,
  HypERC20__factory,
  HypERC4626Collateral__factory,
  HypERC4626OwnerCollateral__factory,
  HypERC4626__factory,
  HypXERC20Lockbox__factory,
  HypXERC20__factory,
  IFiatToken__factory,
  IMessageTransmitter__factory,
  ISafe__factory,
  IWETH__factory,
  IXERC20__factory,
  MovableCollateralRouter__factory,
  OpL1NativeTokenBridge__factory,
  OpL2NativeTokenBridge__factory,
  Ownable__factory,
  PackageVersioned__factory,
  ProxyAdmin__factory,
  TokenBridgeCctpBase__factory,
  TokenBridgeCctpV2__factory,
  TokenRouter__factory,
} from '@hyperlane-xyz/core';
import { buildArtifact as coreBuildArtifact } from '@hyperlane-xyz/core/buildArtifact.js';
import {
  Address,
  arrayToObject,
  assert,
  eqAddress,
  getLogLevel,
  isZeroish,
  isZeroishAddress,
  objFilter,
  objMap,
  promiseObjAll,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { ExplorerLicenseType } from '../block-explorer/etherscan.js';
import { DEFAULT_CONTRACT_READ_CONCURRENCY } from '../consts/concurrency.js';
import { isAddressActive } from '../contracts/contracts.js';
import { ContractVerifier } from '../deploy/verify/ContractVerifier.js';
import { VerifyContractTypes } from '../deploy/verify/types.js';
import {
  DerivedTokenFeeConfig,
  EvmTokenFeeReader,
} from '../fee/EvmTokenFeeReader.js';
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
  ContractVerificationStatus,
  DerivedTokenRouterConfig,
  EverclearCollateralTokenConfig,
  EverclearEthBridgeTokenConfig,
  HypTokenConfig,
  HypTokenConfigSchema,
  HypTokenRouterVirtualConfig,
  MovableTokenConfig,
  OpL1TokenConfig,
  OpL2TokenConfig,
  OwnerStatus,
  TokenMetadata,
  XERC20TokenMetadata,
  XERC20Type,
  isMovableCollateralTokenConfig,
} from './types.js';
import { getExtraLockBoxConfigs } from './xerc20.js';

const REBALANCING_CONTRACT_VERSION = '8.0.0';
export const TOKEN_FEE_CONTRACT_VERSION = '10.0.0';
const SCALE_FRACTION_VERSION = '11.0.0-beta.0';

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
  evmTokenFeeReader: EvmTokenFeeReader;

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
    this.evmTokenFeeReader = new EvmTokenFeeReader(multiProvider, chain);

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
      [TokenType.ethEverclear]:
        this.deriveEverclearEthTokenBridgeConfig.bind(this),
      [TokenType.collateralEverclear]:
        this.deriveEverclearCollateralTokenBridgeConfig.bind(this),
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

    const hasRebalancingInterface =
      compareVersions(
        tokenConfig.contractVersion!,
        REBALANCING_CONTRACT_VERSION,
      ) >= 0;

    let allowedRebalancers: Address[] | undefined;
    let allowedRebalancingBridges: MovableTokenConfig['allowedRebalancingBridges'];
    let domains: number[] | undefined;

    // Only movable collateral tokens (collateral/native) have rebalancing config
    if (
      hasRebalancingInterface &&
      isMovableCollateralTokenConfig(tokenConfig)
    ) {
      const movableToken = MovableCollateralRouter__factory.connect(
        warpRouteAddress,
        this.provider,
      );

      try {
        allowedRebalancers = await MovableCollateralRouter__factory.connect(
          warpRouteAddress,
          this.provider,
        ).allowedRebalancers();
      } catch (error) {
        // If this crashes it probably is because the token implementation has not been updated to be a movable collateral
        this.logger.error(
          `Failed to get configured rebalancers for token at "${warpRouteAddress}" on chain ${this.chain}`,
          error,
        );
      }

      try {
        domains = await movableToken.domains();
        const allowedBridgesByDomain = await promiseObjAll(
          objMap(
            arrayToObject(domains.map((domain) => domain.toString())),
            (domain) => movableToken.allowedBridges(domain),
          ),
        );

        allowedRebalancingBridges = objFilter(
          objMap(allowedBridgesByDomain, (_domain, bridges) =>
            bridges.map((bridge) => ({ bridge })),
          ),
          // Remove domains that do not have allowed bridges
          (_domain, bridges): bridges is any => bridges.length !== 0,
        );
      } catch (error) {
        // If this crashes it probably is because the token implementation has not been updated to be a movable collateral
        this.logger.error(
          `Failed to get allowed rebalancer bridges for token at "${warpRouteAddress}" on chain ${this.chain}`,
          error,
        );
      }
    }

    // Fetch tokenFee for ALL token types that support it, not just movable collateral
    const tokenFee = await this.fetchTokenFee(warpRouteAddress, domains);

    return {
      ...routerConfig,
      ...tokenConfig,
      allowedRebalancers,
      allowedRebalancingBridges,
      proxyAdmin,
      destinationGas,
      tokenFee,
    } as DerivedTokenRouterConfig;
  }

  public async fetchTokenFee(
    routerAddress: Address,
    destinations?: number[],
  ): Promise<DerivedTokenFeeConfig | undefined> {
    const TokenRouter = TokenRouter__factory.connect(
      routerAddress,
      this.provider,
    );

    const [packageVersion, tokenFee] = await Promise.all([
      this.fetchPackageVersion(routerAddress),
      TokenRouter.feeRecipient().catch(() => constants.AddressZero),
    ]);

    const hasTokenFeeInterface =
      compareVersions(packageVersion, TOKEN_FEE_CONTRACT_VERSION) >= 0;

    if (!hasTokenFeeInterface) {
      this.logger.debug(
        `Token at address "${routerAddress}" on chain "${this.chain}" does not have a token fee interface`,
      );
      return undefined;
    }

    if (isZeroishAddress(tokenFee)) {
      this.logger.debug(
        `Token at address "${routerAddress}" on chain "${this.chain}" has a no token fee`,
      );
      return undefined;
    }

    const routingDestinations =
      destinations ??
      (await TokenRouter.domains().catch((error) => {
        this.logger.debug(
          `Failed to derive token router domains for routing fee config on "${this.chain}"`,
          error,
        );
        return undefined;
      }));

    return this.evmTokenFeeReader.deriveTokenFeeConfig({
      address: tokenFee,
      routingDestinations,
    });
  }

  async getContractVerificationStatus(chain: ChainName, address: Address) {
    const contractVerificationStatus: Record<
      string,
      ContractVerificationStatus
    > = {};

    const contractType = (await isProxy(this.provider, address))
      ? VerifyContractTypes.Proxy
      : VerifyContractTypes.Implementation;

    if (this.multiProvider.isLocalRpc(chain)) {
      this.logger.debug('Skipping verification for local endpoints');
      return { [contractType]: ContractVerificationStatus.Skipped };
    }
    contractVerificationStatus[contractType] =
      await this.contractVerifier.getContractVerificationStatus(chain, address);

    if (contractType === VerifyContractTypes.Proxy) {
      contractVerificationStatus[VerifyContractTypes.Implementation] =
        await this.contractVerifier.getContractVerificationStatus(
          chain,
          await proxyImplementation(this.provider, address),
        );

      // Derive ProxyAdmin status
      contractVerificationStatus[VerifyContractTypes.ProxyAdmin] =
        await this.contractVerifier.getContractVerificationStatus(
          chain,
          await proxyAdmin(this.provider, address),
        );
    }
    return contractVerificationStatus;
  }

  async getOwnerStatus(chain: ChainName, address: Address) {
    let ownerStatus: Record<string, OwnerStatus> = {};
    if (this.multiProvider.isLocalRpc(chain)) {
      this.logger.debug('Skipping owner verification for local endpoints');
      return {
        [address]: OwnerStatus.Skipped,
      };
    }

    const provider = this.multiProvider.getProvider(chain);
    const owner = await Ownable__factory.connect(address, provider).owner();

    ownerStatus[owner] = (await isAddressActive(provider, owner))
      ? OwnerStatus.Active
      : OwnerStatus.Inactive;

    // Heuristically check if the owner could be a safe by calling expected functions
    // This status will overwrite 'active' status
    try {
      const potentialGnosisSafe = ISafe__factory.connect(owner, provider);

      await Promise.all([
        potentialGnosisSafe.getThreshold(),
        potentialGnosisSafe.nonce(),
      ]);
      ownerStatus[owner] = OwnerStatus.GnosisSafe;
    } catch {
      this.logger.debug(`${owner} may not be a safe`);
    }

    // Check Proxy admin and implementation recursively
    const contractType = (await isProxy(this.provider, address))
      ? VerifyContractTypes.Proxy
      : VerifyContractTypes.Implementation;
    if (contractType === VerifyContractTypes.Proxy) {
      const [proxyStatus, implementationStatus] = await Promise.all([
        this.getOwnerStatus(chain, await proxyAdmin(provider, address)),
        this.getOwnerStatus(
          chain,
          await proxyImplementation(this.provider, address),
        ),
      ]);
      ownerStatus = {
        ...ownerStatus,
        ...proxyStatus,
        ...implementationStatus,
      };
    }

    return ownerStatus;
  }

  async deriveWarpRouteVirtualConfig(
    chain: ChainName,
    address: Address,
  ): Promise<HypTokenRouterVirtualConfig> {
    const virtualConfig: HypTokenRouterVirtualConfig = {
      contractVerificationStatus: await this.getContractVerificationStatus(
        chain,
        address,
      ),

      // Used to check if the top address owner's nonce or code === 0
      ownerStatus: await this.getOwnerStatus(chain, address),
    };

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
      [TokenType.collateralVault]: {
        factory: HypERC4626OwnerCollateral__factory,
        method: 'assetDeposited',
      },
      [TokenType.collateralVaultRebase]: {
        factory: HypERC4626Collateral__factory,
        method: 'NULL_RECIPIENT',
      },
      [TokenType.XERC20Lockbox]: {
        factory: HypXERC20Lockbox__factory,
        method: 'lockbox',
      },
      [TokenType.collateralCctp]: {
        factory: TokenBridgeCctpBase__factory,
        method: 'messageTransmitter',
      },
      [TokenType.collateral]: {
        factory: HypERC20Collateral__factory,
        method: 'wrappedToken',
      },
      [TokenType.syntheticRebase]: {
        factory: HypERC4626__factory,
        method: 'collateralDomain',
      },
    };

    // Temporarily turn off SmartProvider logging
    // Provider errors are expected because deriving will call methods that may not exist in the Bytecode
    this.setSmartProviderLogLevel('silent');

    try {
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

            try {
              const maybeEverclearTokenBridge =
                EverclearTokenBridge__factory.connect(
                  warpRouteAddress,
                  this.provider,
                );

              await maybeEverclearTokenBridge.callStatic.everclearAdapter();

              let everclearTokenType: TokenType = TokenType.collateralEverclear;
              try {
                // if simulating an ETH transfer works this should be the WETH contract
                await this.provider.estimateGas({
                  from: NON_ZERO_SENDER_ADDRESS,
                  to: wrappedToken,
                  data: IWETH__factory.createInterface().encodeFunctionData(
                    'deposit',
                  ),
                  value: 0,
                });

                everclearTokenType = TokenType.ethEverclear;
              } catch (error) {
                this.logger.debug(
                  `Warp route token at address "${warpRouteAddress}" on chain "${this.chain}" is not a ${TokenType.collateralEverclear}`,
                  error,
                );
              }

              return everclearTokenType;
            } catch (error) {
              this.logger.debug(
                `Warp route token at address "${warpRouteAddress}" on chain "${this.chain}" is not a ${TokenType.collateralEverclear}`,
                error,
              );
            }
          }

          return tokenType as TokenType;
        } catch {
          continue;
        }
      }

      const packageVersion = await this.fetchPackageVersion(warpRouteAddress);
      const hasTokenFeeInterface =
        compareVersions(packageVersion, TOKEN_FEE_CONTRACT_VERSION) >= 0;

      const isNativeToken = await this.isNativeWarpToken(
        warpRouteAddress,
        hasTokenFeeInterface,
      );
      if (isNativeToken) {
        return TokenType.native;
      }

      const isSyntheticToken = await this.isSyntheticWarpToken(
        warpRouteAddress,
        hasTokenFeeInterface,
      );
      if (isSyntheticToken) {
        return TokenType.synthetic;
      }

      throw new Error(
        `Error deriving token type for token at address "${warpRouteAddress}" on chain "${this.chain}"`,
      );
    } finally {
      this.setSmartProviderLogLevel(getLogLevel());
    }
  }

  private async isNativeWarpToken(
    warpRouteAddress: Address,
    hasTokenFeeInterface: boolean,
  ): Promise<boolean> {
    try {
      if (hasTokenFeeInterface) {
        const tokenRouter = TokenRouter__factory.connect(
          warpRouteAddress,
          this.provider,
        );
        const tokenAddress = await tokenRouter.token();

        // Native token returns address(0)
        return isZeroishAddress(tokenAddress);
      } else {
        // Check native using estimateGas to send 0 wei. Success implies that the Warp Route has a receive() function
        await this.multiProvider.estimateGas(
          this.chain,
          {
            to: warpRouteAddress,
            value: BigNumber.from(0),
          },
          NON_ZERO_SENDER_ADDRESS, // Use non-zero address as signer is not provided for read commands
        );
        return true;
      }
    } catch (e) {
      this.logger.debug(
        `Warp route token at address "${warpRouteAddress}" on chain "${this.chain}" is not a ${TokenType.native}`,
        e,
      );

      return false;
    }
  }

  private async isSyntheticWarpToken(
    warpRouteAddress: Address,
    hasTokenFeeInterface: boolean,
  ): Promise<boolean> {
    try {
      if (hasTokenFeeInterface) {
        const tokenRouter = TokenRouter__factory.connect(
          warpRouteAddress,
          this.provider,
        );
        const tokenAddress = await tokenRouter.token();

        // HypERC20.token() returns address(this)
        return eqAddress(tokenAddress, warpRouteAddress);
      } else {
        const tokenRouter = HypERC20__factory.connect(
          warpRouteAddress,
          this.provider,
        );

        await tokenRouter.decimals();

        return true;
      }
    } catch (error) {
      this.logger.debug(
        `Warp route token at address "${warpRouteAddress}" on chain "${this.chain}" is not a ${TokenType.synthetic}`,
        error,
      );

      return false;
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

      // TODO: fix this such that it fetches from WL's values too
      return {
        xERC20: {
          warpRouteLimits: {
            type: XERC20Type.Velo,
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
    const [erc20TokenMetadata, xERC20Metadata, scale] = await Promise.all([
      this.fetchERC20Metadata(collateralTokenAddress),
      this.fetchXERC20Config(collateralTokenAddress, hypTokenAddress),
      this.fetchScale(hypTokenAddress),
    ]);

    return {
      ...erc20TokenMetadata,
      type: TokenType.XERC20,
      token: collateralTokenAddress,
      xERC20: xERC20Metadata.xERC20,
      scale,
    };
  }

  private async deriveHypXERC20LockboxTokenConfig(
    hypTokenAddress: Address,
  ): Promise<HypTokenConfig> {
    const hypXERC20TokenLockboxTokenInstance =
      HypXERC20Lockbox__factory.connect(hypTokenAddress, this.provider);

    const xerc20TokenAddress =
      await hypXERC20TokenLockboxTokenInstance.xERC20();
    const [erc20TokenMetadata, xERC20Metadata, lockbox, scale] =
      await Promise.all([
        this.fetchERC20Metadata(xerc20TokenAddress),
        this.fetchXERC20Config(xerc20TokenAddress, hypTokenAddress),
        hypXERC20TokenLockboxTokenInstance.lockbox(),
        this.fetchScale(hypTokenAddress),
      ]);

    return {
      ...erc20TokenMetadata,
      type: TokenType.XERC20Lockbox,
      token: lockbox,
      xERC20: xERC20Metadata.xERC20,
      scale,
    };
  }

  private async deriveHypCollateralCctpTokenConfig(
    hypToken: Address,
  ): Promise<CctpTokenConfig> {
    const collateralConfig =
      await this.deriveHypCollateralTokenConfig(hypToken);

    const tokenBridge = TokenBridgeCctpBase__factory.connect(
      hypToken,
      this.provider,
    );

    const [messageTransmitter, tokenMessenger, urls] = await Promise.all([
      tokenBridge.messageTransmitter(),
      tokenBridge.tokenMessenger(),
      tokenBridge.urls(),
    ]);

    const onchainCctpVersion = await IMessageTransmitter__factory.connect(
      messageTransmitter,
      this.provider,
    ).version();

    if (onchainCctpVersion === 0) {
      return {
        ...collateralConfig,
        type: TokenType.collateralCctp,
        cctpVersion: 'V1',
        messageTransmitter,
        tokenMessenger,
        urls,
      };
    } else if (onchainCctpVersion === 1) {
      const tokenBridgeV2 = TokenBridgeCctpV2__factory.connect(
        hypToken,
        this.provider,
      );
      const [minFinalityThreshold, maxFeeBps] = await Promise.all([
        tokenBridgeV2.minFinalityThreshold(),
        tokenBridgeV2.maxFeeBps(),
      ]);
      return {
        ...collateralConfig,
        type: TokenType.collateralCctp,
        cctpVersion: 'V2',
        messageTransmitter,
        tokenMessenger,
        urls,
        minFinalityThreshold,
        maxFeeBps: maxFeeBps.toNumber(),
      };
    } else {
      throw new Error(`Unsupported CCTP version ${onchainCctpVersion}`);
    }
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
    const [erc20TokenMetadata, scale] = await Promise.all([
      this.fetchERC20Metadata(collateralTokenAddress),
      this.fetchScale(hypToken),
    ]);

    return {
      ...erc20TokenMetadata,
      type: TokenType.collateral,
      token: collateralTokenAddress,
      scale,
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
      token: await HypERC4626OwnerCollateral__factory.connect(
        hypToken,
        this.provider,
      ).vault(),
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
      token: await HypERC4626Collateral__factory.connect(
        hypToken,
        this.provider,
      ).vault(),
      type: TokenType.collateralVaultRebase,
    };
  }

  private async deriveHypSyntheticTokenConfig(
    hypTokenAddress: Address,
  ): Promise<HypTokenConfig> {
    const [erc20TokenMetadata, scale] = await Promise.all([
      this.fetchERC20Metadata(hypTokenAddress),
      this.fetchScale(hypTokenAddress),
    ]);

    return {
      ...erc20TokenMetadata,
      type: TokenType.synthetic,
      scale,
    };
  }

  private async deriveHypNativeTokenConfig(
    tokenRouterAddress: Address,
  ): Promise<HypTokenConfig> {
    const chainMetadata = this.multiProvider.getChainMetadata(this.chain);
    if (!chainMetadata.nativeToken) {
      throw new Error(
        `Warp route config specifies native token but chain metadata for chain "${this.chain}" does not provide native token details`,
      );
    }

    const { name, symbol, decimals } = chainMetadata.nativeToken;
    const scale = await this.fetchScale(tokenRouterAddress);

    return {
      type: TokenType.native,
      name,
      symbol,
      decimals,
      isNft: false,
      scale,
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

    const [erc20TokenMetadata, collateralDomainId, scale] = await Promise.all([
      this.fetchERC20Metadata(hypTokenAddress),
      hypERC4626.collateralDomain(),
      this.fetchScale(hypTokenAddress),
    ]);

    const collateralChainName =
      this.multiProvider.getChainName(collateralDomainId);

    return {
      ...erc20TokenMetadata,
      type: TokenType.syntheticRebase,
      collateralChainName,
      scale,
    };
  }

  private async deriveEverclearBaseBridgeConfig(
    everclearTokenbridgeInstance: EverclearTokenBridge,
  ): Promise<
    Pick<
      EverclearEthBridgeTokenConfig,
      'everclearBridgeAddress' | 'outputAssets' | 'everclearFeeParams'
    >
  > {
    const [everclearBridgeAddress, domains] = await Promise.all([
      everclearTokenbridgeInstance.everclearAdapter(),
      everclearTokenbridgeInstance.domains(),
    ]);

    const outputAssets = await promiseObjAll(
      objMap(arrayToObject(domains.map(String)), async (domainId, _) =>
        everclearTokenbridgeInstance.outputAssets(domainId),
      ),
    );

    // Remove unset domains from the output
    const filteredOutputAssets = objFilter(
      outputAssets,
      (_domainId, assetAddress): assetAddress is string =>
        !isZeroish(assetAddress),
    );

    const feeParamsByDomain = await promiseObjAll(
      objMap(arrayToObject(domains.map(String)), async (domainId, _) => {
        const [fee, deadline, signature] =
          await everclearTokenbridgeInstance.feeParams(domainId);

        return {
          deadline: deadline.toNumber(),
          fee: fee.toNumber(),
          signature,
        };
      }),
    );

    // Remove unset fee params from the output
    const filteredFeeParamsByDomain = objFilter(
      feeParamsByDomain,
      (
        _domainId,
        feeConfig,
      ): feeConfig is EverclearEthBridgeTokenConfig['everclearFeeParams'][number] => {
        // if all the fields have their default value then the fee config for the
        // current domain is unset
        return !(
          feeConfig.deadline === 0 &&
          feeConfig.fee === 0 &&
          feeConfig.signature === '0x'
        );
      },
    );

    return {
      everclearBridgeAddress,
      outputAssets: filteredOutputAssets,
      everclearFeeParams: filteredFeeParamsByDomain,
    };
  }

  private async deriveEverclearEthTokenBridgeConfig(
    hypTokenAddress: Address,
  ): Promise<EverclearEthBridgeTokenConfig> {
    const everclearTokenbridgeInstance = EverclearTokenBridge__factory.connect(
      hypTokenAddress,
      this.provider,
    );

    const wethAddress = await everclearTokenbridgeInstance.wrappedToken();
    const { everclearBridgeAddress, everclearFeeParams, outputAssets } =
      await this.deriveEverclearBaseBridgeConfig(everclearTokenbridgeInstance);

    return {
      type: TokenType.ethEverclear,
      wethAddress,
      everclearBridgeAddress,
      everclearFeeParams,
      outputAssets,
    };
  }

  private async deriveEverclearCollateralTokenBridgeConfig(
    hypTokenAddress: Address,
  ): Promise<EverclearCollateralTokenConfig> {
    const everclearTokenbridgeInstance = EverclearTokenBridge__factory.connect(
      hypTokenAddress,
      this.provider,
    );

    const collateralTokenAddress =
      await everclearTokenbridgeInstance.wrappedToken();
    const [
      erc20TokenMetadata,
      { everclearBridgeAddress, everclearFeeParams, outputAssets },
      scale,
    ] = await Promise.all([
      this.fetchERC20Metadata(collateralTokenAddress),
      this.deriveEverclearBaseBridgeConfig(everclearTokenbridgeInstance),
      this.fetchScale(hypTokenAddress),
    ]);

    return {
      type: TokenType.collateralEverclear,
      ...erc20TokenMetadata,
      token: collateralTokenAddress,
      everclearBridgeAddress,
      everclearFeeParams,
      outputAssets,
      scale,
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

  /**
   * Fetches the scale configuration from a TokenRouter contract.
   * Handles version compatibility based on contract version - reads scaleNumerator/scaleDenominator
   * for contracts >= 11.0.0, otherwise reads legacy scale value.
   *
   * @param tokenRouterAddress - The address of the TokenRouter contract.
   * @returns The scale as either a number/string (for old contracts or when denominator is 1) or an object with numerator/denominator.
   */
  async fetchScale(
    tokenRouterAddress: Address,
  ): Promise<
    | number
    | string
    | { numerator: number | string; denominator: number | string }
  > {
    const packageVersion = await this.fetchPackageVersion(tokenRouterAddress);
    const hasScaleFractionInterface =
      compareVersions(packageVersion, SCALE_FRACTION_VERSION) >= 0;

    const tokenRouter = TokenRouter__factory.connect(
      tokenRouterAddress,
      this.provider,
    );

    // Helper to safely convert BigNumber to number or string
    // Uses string representation for values > Number.MAX_SAFE_INTEGER
    const safeToNumberOrString = (bn: BigNumber): number | string => {
      try {
        return bn.toNumber();
      } catch {
        // Value exceeds Number.MAX_SAFE_INTEGER, return as string
        return bn.toString();
      }
    };

    if (hasScaleFractionInterface) {
      // Read new format (scaleNumerator and scaleDenominator)
      const [numerator, denominator] = await Promise.all([
        tokenRouter.scaleNumerator(),
        tokenRouter.scaleDenominator(),
      ]);

      // If denominator is 1, return as a simple number/string for backward compatibility
      if (denominator.eq(1)) {
        return safeToNumberOrString(numerator);
      }

      return {
        numerator: safeToNumberOrString(numerator),
        denominator: safeToNumberOrString(denominator),
      };
    } else {
      // Read old format (single scale value) using low-level call
      // Create a custom contract instance with the old scale() method ABI
      const legacyScaleABI = [
        'function scale() external view returns (uint256)',
      ];
      const legacyContract = new Contract(
        tokenRouterAddress,
        legacyScaleABI,
        this.provider,
      );
      const scale = await legacyContract.scale();
      return safeToNumberOrString(scale);
    }
  }

  async fetchPackageVersion(address: Address) {
    const contractWithVersion = PackageVersioned__factory.connect(
      address,
      this.provider,
    );

    try {
      return await contractWithVersion.PACKAGE_VERSION();
    } catch (err: any) {
      if (err.cause?.code && err.cause?.code === 'CALL_EXCEPTION') {
        // PACKAGE_VERSION was introduced in @hyperlane-xyz/core@5.4.0
        // See https://github.com/hyperlane-xyz/hyperlane-monorepo/releases/tag/%40hyperlane-xyz%2Fcore%405.4.0
        // The real version of a contract without this function is below 5.4.0
        return '5.3.9';
      } else {
        this.logger.error(`Error when fetching package version ${err}`);
        return '0.0.0';
      }
    }
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
