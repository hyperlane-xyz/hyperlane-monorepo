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
  CrossCollateralRouter__factory,
  TokenBridgeOft__factory,
} from '@hyperlane-xyz/multicollateral';
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
import { NormalizedScale } from '../utils/decimals.js';

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
  OftTokenConfig,
  OpL1TokenConfig,
  OpL2TokenConfig,
  OwnerStatus,
  TokenMetadata,
  XERC20TokenMetadata,
  XERC20Type,
  isMovableCollateralTokenConfig,
  isCrossCollateralTokenConfig,
} from './types.js';
import { getExtraLockBoxConfigs } from './xerc20.js';

const REBALANCING_CONTRACT_VERSION = '8.0.0';
export const TOKEN_FEE_CONTRACT_VERSION = '10.0.0';

// version that introduced the fractional scale interface
const SCALE_FRACTION_VERSION = '11.0.0';

// version that introduced the legacy scale interface
// https://github.com/hyperlane-xyz/hyperlane-monorepo/releases/tag/%40hyperlane-xyz%2Fcore%406.0.0
const SCALE_VERSION = '6.0.0';

// Version that first introduced ppm precision for CCTP V2 fee storage (was bps before)
export const CCTP_PPM_STORAGE_VERSION = '10.2.0';
// Version that renamed maxFeeBps() to maxFeePpm() on-chain
export const CCTP_PPM_PRECISION_VERSION = '11.0.0';

export class EvmWarpRouteReader extends EvmRouterReader {
  protected readonly logger = rootLogger.child({
    module: 'EvmWarpRouteReader',
  });
  protected readonly packageVersionCache = new Map<string, string>();
  protected readonly packageVersionInflight = new Map<
    string,
    Promise<string>
  >();

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
      [TokenType.unknown]: null,
      [TokenType.syntheticRebase]:
        this.deriveHypSyntheticRebaseConfig.bind(this),
      [TokenType.nativeScaled]: null,
      [TokenType.collateralUri]: null,
      [TokenType.syntheticUri]: null,
      [TokenType.ethEverclear]:
        this.deriveEverclearEthTokenBridgeConfig.bind(this),
      [TokenType.collateralEverclear]:
        this.deriveEverclearCollateralTokenBridgeConfig.bind(this),
      [TokenType.collateralOft]:
        this.deriveHypCollateralOftTokenConfig.bind(this),
      [TokenType.crossCollateral]:
        this.deriveCrossCollateralTokenConfig.bind(this),
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
   * Derives the configuration for a Hyperlane warp route token router contract at the given address.
   *
   * @param warpRouteAddress - The address of the Hyperlane warp route token router contract.
   * @returns The configuration for the Hyperlane warp route token router.
   *
   */
  async deriveWarpRouteConfig(
    warpRouteAddress: Address,
  ): Promise<DerivedTokenRouterConfig> {
    // Derive the config type
    const type = await this.deriveTokenType(warpRouteAddress);
    const isOft = type === TokenType.collateralOft;
    const tokenConfigPromise = this.fetchTokenConfig(type, warpRouteAddress);
    const tokenRouterDomainsPromise = isOft
      ? undefined
      : TokenRouter__factory.connect(warpRouteAddress, this.provider).domains();
    const tokenFeePromise = this.fetchTokenFee(
      warpRouteAddress,
      undefined,
      tokenRouterDomainsPromise,
    );
    // OFT contracts don't have Router/MailboxClient interfaces — read owner directly.
    // Start the router-side reads now so they overlap with token config derivation.
    const routerConfigPromise = isOft
      ? Ownable__factory.connect(warpRouteAddress, this.provider)
          .owner()
          .then((owner) => ({ owner }))
      : this.readRouterConfig(warpRouteAddress);
    const proxyAdminPromise = (async () =>
      (await isProxy(this.provider, warpRouteAddress))
        ? this.fetchProxyAdminConfig(warpRouteAddress)
        : undefined)();
    const [tokenConfig, routerConfig, proxyAdmin, tokenFee] = await Promise.all(
      [
        tokenConfigPromise,
        routerConfigPromise,
        proxyAdminPromise,
        tokenFeePromise,
      ],
    );

    // if the token has not been deployed as a proxy do not derive the config
    // inevm warp routes are an example
    // OFT contracts don't have destination gas config
    // For CrossCollateralRouter tokens, include domains from crossCollateralRouters so
    // fetchDestinationGas also reads gas for MC-only enrolled domains.
    let destinationGas: Record<string, string> | undefined;
    if (isOft) {
      destinationGas = undefined;
    } else {
      const mcEnrolledDomains: number[] = [];
      if (
        isCrossCollateralTokenConfig(tokenConfig) &&
        tokenConfig.crossCollateralRouters
      ) {
        for (const domain of Object.keys(tokenConfig.crossCollateralRouters)) {
          mcEnrolledDomains.push(Number(domain));
        }
      }
      destinationGas = await this.fetchDestinationGas(
        warpRouteAddress,
        mcEnrolledDomains,
      );
    }

    const hasRebalancingInterface =
      compareVersions(
        tokenConfig.contractVersion!,
        REBALANCING_CONTRACT_VERSION,
      ) >= 0;

    let allowedRebalancers: Address[] | undefined;
    let allowedRebalancingBridges: MovableTokenConfig['allowedRebalancingBridges'];

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
        const domains = await this.fetchTokenRouterDomains(
          movableToken,
          tokenRouterDomainsPromise,
        );
        assert(
          domains,
          `Failed to derive token router domains for allowed rebalancer bridges on "${this.chain}"`,
        );
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

    // CCTP tokens implement their own ISM (the contract itself acts as the ISM via AbstractCcipReadIsm).
    // The ISM is hardcoded and not configurable, so we return zero address to match deploy config expectations.
    if (
      type === TokenType.collateralCctp &&
      'interchainSecurityModule' in routerConfig
    ) {
      routerConfig.interchainSecurityModule = constants.AddressZero;
    }

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

  private async fetchTokenRouterDomains(
    tokenRouter: { domains: () => Promise<number[]> },
    domainsPromise?: Promise<number[]>,
  ): Promise<number[] | undefined> {
    if (domainsPromise) {
      try {
        const domains = await domainsPromise;
        if (domains) return domains;
      } catch (error) {
        this.logger.debug(
          `Failed to derive token router domains from shared read on "${this.chain}"`,
          error,
        );
      }
    }

    try {
      return await tokenRouter.domains();
    } catch (error) {
      this.logger.debug(
        `Failed to derive token router domains on "${this.chain}"`,
        error,
      );
      return undefined;
    }
  }

  public async fetchTokenFee(
    routerAddress: Address,
    destinations?: number[],
    destinationsPromise?: Promise<number[] | undefined>,
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
      (await this.fetchTokenRouterDomains(
        TokenRouter,
        destinationsPromise as Promise<number[]> | undefined,
      ));

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
    const contractTypes = [
      {
        tokenType: TokenType.collateralVault,
        factory: HypERC4626OwnerCollateral__factory,
        method: 'assetDeposited',
      },
      {
        tokenType: TokenType.collateralVaultRebase,
        factory: HypERC4626Collateral__factory,
        method: 'NULL_RECIPIENT',
      },
      {
        tokenType: TokenType.XERC20Lockbox,
        factory: HypXERC20Lockbox__factory,
        method: 'lockbox',
      },
      {
        tokenType: TokenType.collateralOft,
        factory: TokenBridgeOft__factory,
        method: 'oft',
      },
      {
        tokenType: TokenType.collateralCctp,
        factory: TokenBridgeCctpBase__factory,
        method: 'messageTransmitter',
      },
      {
        tokenType: TokenType.collateral,
        factory: HypERC20Collateral__factory,
        method: 'wrappedToken',
      },
      {
        tokenType: TokenType.syntheticRebase,
        factory: HypERC4626__factory,
        method: 'collateralDomain',
      },
    ] as const;
    const packageVersionPromise = this.fetchPackageVersion(warpRouteAddress);

    // Temporarily turn off SmartProvider logging
    // Provider errors are expected because deriving will call methods that may not exist in the Bytecode
    this.setSmartProviderLogLevel('silent');

    try {
      const batchedProbeResults = await this.tryProbeContractBatch(
        contractTypes.map(({ factory, method }) => ({
          target: warpRouteAddress,
          contractInterface: factory.createInterface(),
          method,
        })),
      );

      for (let i = 0; i < contractTypes.length; i += 1) {
        const { tokenType, factory, method } = contractTypes[i];
        const probeResult =
          batchedProbeResults !== undefined
            ? batchedProbeResults[i]
            : await this.probeContractCall(
                warpRouteAddress,
                factory.createInterface(),
                method,
              );
        if (probeResult === undefined) {
          continue;
        }

        if (tokenType === TokenType.collateral) {
          return this.deriveCollateralSubtype(
            warpRouteAddress,
            probeResult as Address,
          );
        }

        return tokenType;
      }

      const fallbackTokenType = await this.deriveNativeOrSyntheticTokenType(
        warpRouteAddress,
        await packageVersionPromise,
      );
      if (fallbackTokenType !== undefined) {
        return fallbackTokenType;
      }

      throw new Error(
        `Error deriving token type for token at address "${warpRouteAddress}" on chain "${this.chain}"`,
      );
    } finally {
      this.setSmartProviderLogLevel(getLogLevel());
    }
  }

  private async deriveCollateralSubtype(
    warpRouteAddress: Address,
    wrappedToken: Address,
  ): Promise<TokenType> {
    const batchedSubtypeProbes = await this.tryProbeContractBatch([
      {
        target: wrappedToken,
        contractInterface: IXERC20__factory.createInterface(),
        method: 'mintingCurrentLimitOf(address)',
        args: [warpRouteAddress],
      },
      {
        target: warpRouteAddress,
        contractInterface: EverclearTokenBridge__factory.createInterface(),
        method: 'everclearAdapter',
      },
      {
        target: warpRouteAddress,
        contractInterface: CrossCollateralRouter__factory.createInterface(),
        method: 'getCrossCollateralRouters',
        args: [0],
      },
    ]);

    const xerc20Limit =
      batchedSubtypeProbes !== undefined
        ? batchedSubtypeProbes[0]
        : await this.probeContractCall(
            wrappedToken,
            IXERC20__factory.createInterface(),
            'mintingCurrentLimitOf(address)',
            [warpRouteAddress],
          );
    if (xerc20Limit !== undefined) {
      return TokenType.XERC20;
    }

    // This probe needs `{ from: warpRouteAddress }`, which the batched probe
    // wrapper cannot express today.
    const fiatMintProbe = await this.probeContractCall(
      wrappedToken,
      IFiatToken__factory.createInterface(),
      'mint',
      [NON_ZERO_SENDER_ADDRESS, 1],
      { from: warpRouteAddress },
    );
    if (fiatMintProbe !== undefined) {
      return TokenType.collateralFiat;
    }

    const everclearAdapter =
      batchedSubtypeProbes !== undefined
        ? batchedSubtypeProbes[1]
        : await this.probeContractCall(
            warpRouteAddress,
            EverclearTokenBridge__factory.createInterface(),
            'everclearAdapter',
          );
    if (everclearAdapter !== undefined) {
      let everclearTokenType: TokenType = TokenType.collateralEverclear;
      const depositGas = await this.probeContractEstimateGas({
        from: NON_ZERO_SENDER_ADDRESS,
        to: wrappedToken,
        data: IWETH__factory.createInterface().encodeFunctionData('deposit'),
        value: 0,
      });

      if (depositGas !== undefined) {
        everclearTokenType = TokenType.ethEverclear;
      }

      return everclearTokenType;
    }

    const crossCollateralRouters =
      batchedSubtypeProbes !== undefined
        ? batchedSubtypeProbes[2]
        : await this.probeContractCall(
            warpRouteAddress,
            CrossCollateralRouter__factory.createInterface(),
            'getCrossCollateralRouters',
            [0],
          );
    if (crossCollateralRouters !== undefined) {
      return TokenType.crossCollateral;
    }

    return TokenType.collateral;
  }

  private async deriveNativeOrSyntheticTokenType(
    warpRouteAddress: Address,
    packageVersion: string,
  ): Promise<TokenType | undefined> {
    const hasTokenFeeInterface =
      compareVersions(packageVersion, TOKEN_FEE_CONTRACT_VERSION) >= 0;

    if (hasTokenFeeInterface) {
      const tokenAddress = await this.probeContractCall<Address>(
        warpRouteAddress,
        TokenRouter__factory.createInterface(),
        'token',
      );

      if (tokenAddress === undefined) {
        return undefined;
      }
      if (isZeroishAddress(tokenAddress)) {
        return TokenType.native;
      }
      if (eqAddress(tokenAddress, warpRouteAddress)) {
        return TokenType.synthetic;
      }

      return undefined;
    }

    const [gasEstimateResult, decimalsResult] = await Promise.allSettled([
      this.probeContractEstimateGas({
        from: NON_ZERO_SENDER_ADDRESS,
        to: warpRouteAddress,
        value: BigNumber.from(0),
      }),
      this.probeContractCall(
        warpRouteAddress,
        HypERC20__factory.createInterface(),
        'decimals',
      ),
    ]);

    if (gasEstimateResult.status === 'rejected') {
      throw gasEstimateResult.reason;
    }
    if (gasEstimateResult.value !== undefined) {
      return TokenType.native;
    }

    if (decimalsResult.status === 'rejected') {
      throw decimalsResult.reason;
    }
    if (decimalsResult.value !== undefined) {
      return TokenType.synthetic;
    }

    return undefined;
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

    // Convert ppm to bps for CCTP V2 contracts that store fees in ppm (>= 10.2.0)
    if (
      config.type === TokenType.collateralCctp &&
      config.cctpVersion === 'V2' &&
      config.maxFeeBps !== undefined &&
      config.contractVersion &&
      compareVersions(config.contractVersion, CCTP_PPM_STORAGE_VERSION) >= 0
    ) {
      config.maxFeeBps = config.maxFeeBps / 100;
    }

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

    const tokenBridgeInterface = TokenBridgeCctpBase__factory.createInterface();
    const [messageTransmitter, tokenMessenger, urls] =
      (await this.readContractBatch([
        {
          target: hypToken,
          contractInterface: tokenBridgeInterface,
          method: 'messageTransmitter',
        },
        {
          target: hypToken,
          contractInterface: tokenBridgeInterface,
          method: 'tokenMessenger',
        },
        {
          target: hypToken,
          contractInterface: tokenBridgeInterface,
          method: 'urls',
        },
      ])) as [Address, Address, string[]];

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
      const tokenBridgeV2Interface =
        TokenBridgeCctpV2__factory.createInterface();
      const contractVersion = await this.fetchPackageVersion(hypToken);
      const usesPpmName =
        contractVersion !== undefined &&
        compareVersions(contractVersion, CCTP_PPM_PRECISION_VERSION) >= 0;
      const minFinalityThresholdCall = {
        target: hypToken,
        contractInterface: tokenBridgeV2Interface,
        method: 'minFinalityThreshold',
      };

      const [minFinalityThreshold, maxFeePpm] = usesPpmName
        ? ((await this.readContractBatch<unknown>([
            minFinalityThresholdCall,
            {
              target: hypToken,
              contractInterface: tokenBridgeV2Interface,
              method: 'maxFeePpm',
            },
          ])) as [number, BigNumber])
        : await Promise.all([
            this.readContractBatch<number>([minFinalityThresholdCall]).then(
              ([result]) => result,
            ),
            TokenBridgeCctpV2__factory.connect(hypToken, this.provider)
              .provider.call({
                to: hypToken,
                data: '0xbf769a3f',
              })
              .then((result) => BigNumber.from(result)),
          ]);

      return {
        ...collateralConfig,
        type: TokenType.collateralCctp,
        cctpVersion: 'V2',
        messageTransmitter,
        tokenMessenger,
        urls,
        minFinalityThreshold,
        maxFeeBps: maxFeePpm.toNumber(),
      };
    } else {
      throw new Error(`Unsupported CCTP version ${onchainCctpVersion}`);
    }
  }

  private async deriveHypCollateralOftTokenConfig(
    hypToken: Address,
  ): Promise<OftTokenConfig> {
    const tokenBridgeInterface = TokenBridgeOft__factory.createInterface();
    const [oft, token, extraOptions, domainMappingsRaw] =
      (await this.readContractBatch([
        {
          target: hypToken,
          contractInterface: tokenBridgeInterface,
          method: 'oft',
        },
        {
          target: hypToken,
          contractInterface: tokenBridgeInterface,
          method: 'token',
        },
        {
          target: hypToken,
          contractInterface: tokenBridgeInterface,
          method: 'extraOptions',
        },
        {
          target: hypToken,
          contractInterface: tokenBridgeInterface,
          method: 'getDomainMappings',
        },
      ])) as [
        string,
        Address,
        string,
        [Array<{ toString(): string }>, number[]],
      ];

    const erc20Metadata = await this.fetchERC20Metadata(token);

    const domainMappings: Record<string, number> = {};
    const [domains, lzEids] = domainMappingsRaw;
    for (let i = 0; i < domains.length; i++) {
      domainMappings[domains[i].toString()] = lzEids[i];
    }

    return {
      ...erc20Metadata,
      type: TokenType.collateralOft,
      token,
      oft,
      domainMappings,
      extraOptions: extraOptions !== '0x' ? extraOptions : undefined,
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

  /**
   * Derives the configuration for a CrossCollateralRouter router.
   */
  private async deriveCrossCollateralTokenConfig(
    hypTokenAddress: Address,
  ): Promise<HypTokenConfig> {
    const crossCollateralRouterInterface =
      CrossCollateralRouter__factory.createInterface();
    const tokenRouterInterface = TokenRouter__factory.createInterface();
    const [
      [
        collateralTokenAddress,
        remoteDomains,
        crossCollateralDomains,
        localDomain,
      ],
      scale,
    ] = await Promise.all([
      this.readContractBatch([
        {
          target: hypTokenAddress,
          contractInterface: crossCollateralRouterInterface,
          method: 'wrappedToken',
        },
        {
          target: hypTokenAddress,
          contractInterface: tokenRouterInterface,
          method: 'domains',
        },
        {
          target: hypTokenAddress,
          contractInterface: crossCollateralRouterInterface,
          method: 'getCrossCollateralDomains',
        },
        {
          target: hypTokenAddress,
          contractInterface: crossCollateralRouterInterface,
          method: 'localDomain',
        },
      ]) as Promise<[Address, any[], any[], number]>,
      this.fetchScale(hypTokenAddress),
    ]);

    const erc20TokenMetadata = await this.fetchERC20Metadata(
      collateralTokenAddress,
    );

    // Merge Router._routers domains, MC-enrolled domains, and localDomain
    const allDomains = [
      ...new Set([
        ...remoteDomains.map(Number),
        ...crossCollateralDomains.map(Number),
        localDomain,
      ]),
    ];
    const routersByDomain = await this.readContractBatch<string[]>(
      allDomains.map((domain) => ({
        target: hypTokenAddress,
        contractInterface: crossCollateralRouterInterface,
        method: 'getCrossCollateralRouters',
        args: [domain],
      })),
    );
    const crossCollateralRouters = Object.fromEntries(
      allDomains
        .map((domain, index) => [domain.toString(), routersByDomain[index]])
        .filter(([, routers]) => routers.length > 0),
    );

    return {
      ...erc20TokenMetadata,
      type: TokenType.crossCollateral,
      token: collateralTokenAddress,
      scale,
      crossCollateralRouters:
        Object.keys(crossCollateralRouters).length > 0
          ? crossCollateralRouters
          : undefined,
    };
  }

  async fetchERC20Metadata(tokenAddress: Address): Promise<TokenMetadata> {
    const erc20Interface = HypERC20__factory.createInterface();
    const [name, symbol, decimals] = (await this.readContractBatch([
      {
        target: tokenAddress,
        contractInterface: erc20Interface,
        method: 'name',
      },
      {
        target: tokenAddress,
        contractInterface: erc20Interface,
        method: 'symbol',
      },
      {
        target: tokenAddress,
        contractInterface: erc20Interface,
        method: 'decimals',
      },
    ])) as [string, string, number];

    return { name, symbol, decimals, isNft: false };
  }

  /**
   * Fetches the scale configuration from a TokenRouter contract.
   * Handles version compatibility based on contract version - reads scaleNumerator/scaleDenominator
   * for contracts >= 11.0.0, otherwise reads legacy scale value.
   *
   * @param tokenRouterAddress - The address of the TokenRouter contract.
   * @returns The scale as a NormalizedScale, or undefined when the scale is the identity (1/1).
   */
  async fetchScale(
    tokenRouterAddress: Address,
  ): Promise<NormalizedScale | undefined> {
    const packageVersion = await this.fetchPackageVersion(tokenRouterAddress);
    const hasScaleFractionInterface =
      compareVersions(packageVersion, SCALE_FRACTION_VERSION) >= 0;
    const hasScaleInterface =
      compareVersions(packageVersion, SCALE_VERSION) >= 0;

    if (!hasScaleFractionInterface && !hasScaleInterface) {
      return;
    }

    let result: NormalizedScale;
    if (hasScaleFractionInterface) {
      const tokenRouterInterface = TokenRouter__factory.createInterface();
      const [numerator, denominator] = (await this.readContractBatch<BigNumber>(
        [
          {
            target: tokenRouterAddress,
            contractInterface: tokenRouterInterface,
            method: 'scaleNumerator',
          },
          {
            target: tokenRouterAddress,
            contractInterface: tokenRouterInterface,
            method: 'scaleDenominator',
          },
        ],
      )) as [BigNumber, BigNumber];

      result = {
        numerator: numerator.toBigInt(),
        denominator: denominator.toBigInt(),
      };
    } else {
      // Read old format (single scale value) using low-level call
      const legacyScaleABI = [
        'function scale() external view returns (uint256)',
      ];
      const legacyContract = new Contract(
        tokenRouterAddress,
        legacyScaleABI,
        this.provider,
      );
      const scale: BigNumber = await legacyContract.scale();
      result = { numerator: scale.toBigInt(), denominator: 1n };
    }

    // Omit identity scale so derived config matches deploy configs that
    // don't specify scale (i.e. uniform-decimal routes).
    if (result.numerator === 1n && result.denominator === 1n) {
      return undefined;
    }
    return result;
  }

  async fetchPackageVersion(address: Address) {
    const cacheKey = address.toLowerCase();
    const cachedVersion = this.packageVersionCache.get(cacheKey);
    if (cachedVersion) return cachedVersion;

    const inFlight = this.packageVersionInflight.get(cacheKey);
    if (inFlight) return inFlight;

    const versionPromise = (async () => {
      const contractWithVersion = PackageVersioned__factory.connect(
        address,
        this.provider,
      );

      try {
        const version = await contractWithVersion.PACKAGE_VERSION();
        this.packageVersionCache.set(cacheKey, version);
        return version;
      } catch (err: any) {
        if (err.cause?.code && err.cause?.code === 'CALL_EXCEPTION') {
          // PACKAGE_VERSION was introduced in @hyperlane-xyz/core@5.4.0
          // See https://github.com/hyperlane-xyz/hyperlane-monorepo/releases/tag/%40hyperlane-xyz%2Fcore%405.4.0
          // The real version of a contract without this function is below 5.4.0
          const legacyVersion = '5.3.9';
          this.packageVersionCache.set(cacheKey, legacyVersion);
          return legacyVersion;
        } else {
          this.logger.error(`Error when fetching package version ${err}`);
          const unknownVersion = '0.0.0';
          this.packageVersionCache.set(cacheKey, unknownVersion);
          return unknownVersion;
        }
      } finally {
        this.packageVersionInflight.delete(cacheKey);
      }
    })();

    this.packageVersionInflight.set(cacheKey, versionPromise);
    return versionPromise;
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
    additionalDomains: number[] = [],
  ): Promise<DestinationGas> {
    const warpRoute = TokenRouter__factory.connect(
      warpRouteAddress,
      this.provider,
    );

    /**
     * @remark
     * Router.domains() is used to enumerate the destination gas because GasRouter.destinationGas is not EnumerableMapExtended type
     * This means that if a domain is removed, then we cannot read the destinationGas for it. This may impact updates.
     * For CrossCollateralRouter contracts, additionalDomains includes domains that only
     * have MC-enrolled routers (not in Router._routers), so their gas is also read.
     */
    const routerDomains = await warpRoute.domains();
    const allDomains = [
      ...new Set([...routerDomains.map(Number), ...additionalDomains]),
    ];
    const routerInterface = TokenRouter__factory.createInterface();
    const gasValues = await this.readContractBatch<BigNumber>(
      allDomains.map((domain) => ({
        target: warpRouteAddress,
        contractInterface: routerInterface,
        method: 'destinationGas',
        args: [domain],
      })),
    );

    return Object.fromEntries(
      allDomains.map((domain, index) => [domain, gasValues[index].toString()]),
    );
  }
}
