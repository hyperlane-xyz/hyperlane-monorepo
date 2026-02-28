import { compareVersions } from 'compare-versions';
import { BigNumber, constants } from 'ethers';

import {
  ERC20__factory,
  EverclearTokenBridge__factory,
  GasRouter,
  IMessageTransmitter__factory,
  MovableCollateralRouter__factory,
  OpL1V1NativeTokenBridge__factory,
  OpL2NativeTokenBridge__factory,
  PackageVersioned__factory,
  TokenBridgeCctpBase__factory,
  TokenBridgeCctpV2__factory,
  TokenRouter,
} from '@hyperlane-xyz/core';
import { MultiCollateral__factory } from '@hyperlane-xyz/multicollateral';
import {
  Address,
  ProtocolType,
  addressToBytes32,
  assert,
  objFilter,
  objKeys,
  objMap,
  promiseObjAll,
  rootLogger,
} from '@hyperlane-xyz/utils';

import {
  HyperlaneContracts,
  HyperlaneContractsMap,
} from '../contracts/types.js';
import { ContractVerifier } from '../deploy/verify/ContractVerifier.js';
import { EvmTokenFeeModule } from '../fee/EvmTokenFeeModule.js';
import { HyperlaneIsmFactory } from '../ism/HyperlaneIsmFactory.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { GasRouterDeployer } from '../router/GasRouterDeployer.js';
import { resolveRouterMapConfig } from '../router/types.js';
import { ChainMap, ChainName } from '../types.js';

import { normalizeScale } from '../utils/decimals.js';
import {
  CCTP_PPM_PRECISION_VERSION,
  CCTP_PPM_STORAGE_VERSION,
} from './EvmWarpRouteReader.js';
import { TokenMetadataMap } from './TokenMetadataMap.js';
import { DeployableTokenType, gasOverhead } from './config.js';
import { resolveTokenFeeAddress } from './configUtils.js';
import {
  HypERC20Factories,
  HypERC20contracts,
  HypERC721Factories,
  TokenFactories,
  getCctpFactory,
  hypERC20contracts,
  hypERC20factories,
  hypERC721contracts,
  hypERC721factories,
} from './contracts.js';
import { deriveTokenMetadata } from './tokenMetadataUtils.js';
import {
  CctpTokenConfig,
  HypTokenConfig,
  HypTokenRouterConfig,
  WarpRouteDeployConfig,
  WarpRouteDeployConfigMailboxRequired,
  isCctpTokenConfig,
  isCollateralTokenConfig,
  isEverclearCollateralTokenConfig,
  isEverclearEthBridgeTokenConfig,
  isEverclearTokenBridgeConfig,
  isMovableCollateralTokenConfig,
  isMultiCollateralTokenConfig,
  isNativeTokenConfig,
  isOpL1TokenConfig,
  isOpL2TokenConfig,
  isSyntheticRebaseTokenConfig,
  isSyntheticTokenConfig,
  isXERC20TokenConfig,
} from './types.js';

// initialize(address _hook, address _owner)
const OP_L2_INITIALIZE_SIGNATURE = 'initialize(address,address)';
// initialize(address _owner, string[] memory _urls)
const OP_L1_INITIALIZE_SIGNATURE = 'initialize(address,string[])';
// initialize(address _hook, address _owner, string[] memory __urls)
const CCTP_INITIALIZE_SIGNATURE = 'initialize(address,address,string[])';
// initialize(address _hook, address _owner)
const EVERCLEAR_TOKEN_BRIDGE_INITIALIZE_SIGNATURE =
  'initialize(address,address)';

export const TOKEN_INITIALIZE_SIGNATURE = (
  contractName: HypERC20contracts[DeployableTokenType],
) => {
  switch (contractName) {
    case 'OPL2TokenBridgeNative':
      assert(
        OpL2NativeTokenBridge__factory.createInterface().functions[
          OP_L2_INITIALIZE_SIGNATURE
        ],
        'missing expected initialize function',
      );
      return OP_L2_INITIALIZE_SIGNATURE;
    case 'OpL1TokenBridgeNative':
      assert(
        OpL1V1NativeTokenBridge__factory.createInterface().functions[
          OP_L1_INITIALIZE_SIGNATURE
        ],
        'missing expected initialize function',
      );
      return OP_L1_INITIALIZE_SIGNATURE;
    case 'TokenBridgeCctp':
      assert(
        TokenBridgeCctpBase__factory.createInterface().functions[
          CCTP_INITIALIZE_SIGNATURE
        ],
        'missing expected initialize function',
      );
      return CCTP_INITIALIZE_SIGNATURE;
    case 'EverclearTokenBridge':
    case 'EverclearEthBridge':
      assert(
        EverclearTokenBridge__factory.createInterface().functions[
          EVERCLEAR_TOKEN_BRIDGE_INITIALIZE_SIGNATURE
        ],
        'missing expected initialize function',
      );
      return EVERCLEAR_TOKEN_BRIDGE_INITIALIZE_SIGNATURE;
    default:
      return 'initialize';
  }
};

abstract class TokenDeployer<
  Factories extends TokenFactories,
> extends GasRouterDeployer<HypTokenRouterConfig, Factories> {
  constructor(
    multiProvider: MultiProvider,
    factories: Factories,
    loggerName: string,
    ismFactory?: HyperlaneIsmFactory,
    contractVerifier?: ContractVerifier,
    concurrentDeploy = true,
  ) {
    super(multiProvider, factories, {
      logger: rootLogger.child({ module: loggerName }),
      ismFactory,
      contractVerifier,
      concurrentDeploy,
    }); // factories not used in deploy
  }

  async constructorArgs(
    _: ChainName,
    config: HypTokenRouterConfig,
  ): Promise<any> {
    // TODO: derive as specified in https://github.com/hyperlane-xyz/hyperlane-monorepo/issues/5296
    const { numerator, denominator } = normalizeScale(config.scale);

    if (
      isCollateralTokenConfig(config) ||
      isXERC20TokenConfig(config) ||
      isMultiCollateralTokenConfig(config)
    ) {
      return [config.token, numerator, denominator, config.mailbox];
    } else if (isEverclearCollateralTokenConfig(config)) {
      return [
        config.token,
        numerator,
        denominator,
        config.mailbox,
        config.everclearBridgeAddress,
      ];
    } else if (isEverclearEthBridgeTokenConfig(config)) {
      return [
        config.wethAddress,
        config.mailbox,
        config.everclearBridgeAddress,
      ];
    } else if (isNativeTokenConfig(config)) {
      return [numerator, denominator, config.mailbox];
    } else if (isOpL2TokenConfig(config)) {
      return [config.mailbox, config.l2Bridge];
    } else if (isOpL1TokenConfig(config)) {
      return [config.mailbox, config.portal];
    } else if (isSyntheticTokenConfig(config)) {
      assert(config.decimals, 'decimals is undefined for config'); // decimals must be defined by this point
      return [config.decimals, numerator, denominator, config.mailbox];
    } else if (isSyntheticRebaseTokenConfig(config)) {
      const collateralDomain = this.multiProvider.getDomainId(
        config.collateralChainName,
      );
      return [
        config.decimals,
        numerator,
        denominator,
        config.mailbox,
        collateralDomain,
      ];
    } else if (isCctpTokenConfig(config)) {
      switch (config.cctpVersion) {
        case 'V1':
          return [
            config.token,
            config.mailbox,
            config.messageTransmitter,
            config.tokenMessenger,
          ];
        case 'V2': {
          assert(
            config.maxFeeBps !== undefined,
            'maxFeeBps is undefined for CCTP V2 config',
          );
          assert(
            config.minFinalityThreshold !== undefined,
            'minFinalityThreshold is undefined for CCTP V2 config',
          );
          // Convert bps to ppm (parts per million) for contract precision
          // 1 bps = 100 ppm, supports fractional bps (e.g., 1.3 bps = 130 ppm)
          const maxFeePpm = Math.round(config.maxFeeBps * 100);
          return [
            config.token,
            config.mailbox,
            config.messageTransmitter,
            config.tokenMessenger,
            maxFeePpm,
            config.minFinalityThreshold,
          ];
        }
        default:
          throw new Error('Unsupported CCTP version');
      }
    } else {
      throw new Error('Unknown token type when constructing arguments');
    }
  }

  initializeFnSignature(name: string): string {
    return TOKEN_INITIALIZE_SIGNATURE(name as any);
  }

  async initializeArgs(
    chain: ChainName,
    config: HypTokenRouterConfig,
  ): Promise<any> {
    const signer = await this.multiProvider.getSigner(chain).getAddress();
    const defaultArgs = [
      config.hook ?? constants.AddressZero,
      config.interchainSecurityModule ?? constants.AddressZero,
      // TransferOwnership will happen later in RouterDeployer
      signer,
    ];
    if (
      isCollateralTokenConfig(config) ||
      isXERC20TokenConfig(config) ||
      isNativeTokenConfig(config) ||
      isMultiCollateralTokenConfig(config)
    ) {
      return defaultArgs;
    } else if (
      isEverclearCollateralTokenConfig(config) ||
      isEverclearEthBridgeTokenConfig(config)
    ) {
      return [config.hook ?? constants.AddressZero, config.owner];
    } else if (isOpL2TokenConfig(config)) {
      return [config.hook ?? constants.AddressZero, config.owner];
    } else if (isOpL1TokenConfig(config)) {
      return [config.owner, config.urls];
    } else if (isCctpTokenConfig(config)) {
      return [config.hook ?? constants.AddressZero, config.owner, config.urls];
    } else if (isSyntheticTokenConfig(config)) {
      return [
        config.initialSupply ?? 0,
        config.name,
        config.symbol,
        ...defaultArgs,
      ];
    } else if (isSyntheticRebaseTokenConfig(config)) {
      return [0, config.name, config.symbol, ...defaultArgs];
    } else {
      throw new Error('Unknown collateral type when initializing arguments');
    }
  }

  static async deriveTokenMetadata(
    multiProvider: MultiProvider,
    configMap: WarpRouteDeployConfig,
  ): Promise<TokenMetadataMap> {
    return deriveTokenMetadata(multiProvider, configMap);
  }

  protected async configureCctpDomains(
    configMap: ChainMap<HypTokenConfig>,
    deployedContractsMap: HyperlaneContractsMap<Factories>,
  ): Promise<void> {
    const cctpConfigs = objFilter(
      configMap,
      (_, config): config is CctpTokenConfig => isCctpTokenConfig(config),
    );

    const circleDomains = await promiseObjAll(
      objMap(cctpConfigs, (chain, config) =>
        IMessageTransmitter__factory.connect(
          config.messageTransmitter,
          this.multiProvider.getProvider(chain),
        ).localDomain(),
      ),
    );

    const domains = Object.entries(circleDomains).map(([chain, circle]) => ({
      hyperlane: this.multiProvider.getDomainId(chain),
      circle,
    }));

    if (domains.length === 0) {
      return;
    }

    await promiseObjAll(
      objMap(cctpConfigs, async (chain, _config) => {
        const router = this.router(deployedContractsMap[chain]).address;
        const tokenBridge = TokenBridgeCctpBase__factory.connect(
          router,
          this.multiProvider.getSigner(chain),
        );
        const remoteDomains = domains.filter(
          (domain) =>
            domain.hyperlane !== this.multiProvider.getDomainId(chain),
        );
        this.logger.info(`Mapping Circle domains on ${chain}`, {
          remoteDomains,
        });
        await this.multiProvider.handleTx(
          chain,
          tokenBridge.addDomains(remoteDomains),
        );
      }),
    );
  }

  protected async configureCctpV2MaxFee(
    configMap: ChainMap<HypTokenConfig>,
    deployedContractsMap: HyperlaneContractsMap<Factories>,
  ): Promise<void> {
    const cctpV2Configs = objFilter(
      configMap,
      (_, config): config is CctpTokenConfig =>
        isCctpTokenConfig(config) &&
        config.cctpVersion === 'V2' &&
        config.maxFeeBps !== undefined,
    );

    await promiseObjAll(
      objMap(cctpV2Configs, async (chain, config) => {
        const router = this.router(deployedContractsMap[chain]).address;
        const tokenBridgeV2 = TokenBridgeCctpV2__factory.connect(
          router,
          this.multiProvider.getSigner(chain),
        );

        // Check contract version to determine ppm conversion and function name
        const versionedContract = PackageVersioned__factory.connect(
          router,
          this.multiProvider.getProvider(chain),
        );
        const contractVersion = await versionedContract.PACKAGE_VERSION();
        const usesPpmStorage =
          compareVersions(contractVersion, CCTP_PPM_STORAGE_VERSION) >= 0;
        const usesPpmName =
          compareVersions(contractVersion, CCTP_PPM_PRECISION_VERSION) >= 0;

        // Convert bps to ppm for contracts that store fees in ppm (>= 10.2.0)
        const targetFee = usesPpmStorage
          ? Math.round(config.maxFeeBps! * 100)
          : config.maxFeeBps!;

        // Read current fee: >= 11.0.0 uses maxFeePpm(), older uses maxFeeBps()
        const currentMaxFee = usesPpmName
          ? await tokenBridgeV2.maxFeePpm()
          : BigNumber.from(
              await tokenBridgeV2.provider.call({
                to: router,
                // maxFeeBps() selector
                data: '0xbf769a3f',
              }),
            );

        if (currentMaxFee.toNumber() !== targetFee) {
          const currentFeeBps = usesPpmStorage
            ? currentMaxFee.toNumber() / 100
            : currentMaxFee.toNumber();
          this.logger.info(
            `Setting maxFeePpm on ${chain} from ${currentFeeBps} bps to ${config.maxFeeBps} bps${usesPpmStorage ? ' (stored as ppm)' : ''}`,
          );
          // >= 11.0.0 uses setMaxFeePpm(), older uses setMaxFeeBps()
          if (usesPpmName) {
            await this.multiProvider.handleTx(
              chain,
              tokenBridgeV2.setMaxFeePpm(targetFee),
            );
          } else {
            await this.multiProvider.handleTx(
              chain,
              tokenBridgeV2.signer.sendTransaction({
                to: router,
                // setMaxFeeBps(uint256) selector + abi-encoded targetFee
                data:
                  '0x246d4569' +
                  BigNumber.from(targetFee)
                    .toHexString()
                    .slice(2)
                    .padStart(64, '0'),
              }),
            );
          }
        }
      }),
    );
  }

  protected async setRebalancers(
    configMap: ChainMap<HypTokenConfig>,
    deployedContractsMap: HyperlaneContractsMap<Factories>,
  ): Promise<void> {
    await promiseObjAll(
      objMap(configMap, async (chain, config) => {
        if (!isMovableCollateralTokenConfig(config)) {
          return;
        }

        const router = this.router(deployedContractsMap[chain]).address;
        const movableToken = MovableCollateralRouter__factory.connect(
          router,
          this.multiProvider.getSigner(chain),
        );

        const rebalancers = Array.from(config.allowedRebalancers ?? []);
        for (const rebalancer of rebalancers) {
          await this.multiProvider.handleTx(
            chain,
            movableToken.addRebalancer(rebalancer),
          );
        }
      }),
    );
  }

  protected async setAllowedBridges(
    configMap: ChainMap<HypTokenConfig>,
    deployedContractsMap: HyperlaneContractsMap<Factories>,
  ): Promise<void> {
    await promiseObjAll(
      objMap(configMap, async (chain, config) => {
        if (!isMovableCollateralTokenConfig(config)) {
          return;
        }

        const router = this.router(deployedContractsMap[chain]);
        const movableToken = MovableCollateralRouter__factory.connect(
          router.address,
          this.multiProvider.getSigner(chain),
        );

        const bridgesToAllow = Object.entries(
          resolveRouterMapConfig(
            this.multiProvider,
            config.allowedRebalancingBridges ?? {},
          ),
        ).flatMap(([domain, allowedBridgesToAdd]) => {
          return allowedBridgesToAdd.map((bridgeToAdd) => {
            return {
              domain: Number(domain),
              bridge: bridgeToAdd.bridge,
            };
          });
        });

        // Filter out domains that are not enrolled to avoid errors
        const routerDomains = await router.domains();
        const bridgesToAllowOnRouter = bridgesToAllow.filter(({ domain }) =>
          routerDomains.includes(domain),
        );
        for (const bridgeConfig of bridgesToAllowOnRouter) {
          await this.multiProvider.handleTx(
            chain,
            movableToken.addBridge(bridgeConfig.domain, bridgeConfig.bridge),
          );
        }
      }),
    );
  }

  protected async setBridgesTokenApprovals(
    configMap: ChainMap<HypTokenConfig>,
    deployedContractsMap: HyperlaneContractsMap<Factories>,
  ): Promise<void> {
    await promiseObjAll(
      objMap(configMap, async (chain, config) => {
        if (!isMovableCollateralTokenConfig(config)) {
          return;
        }

        const router = this.router(deployedContractsMap[chain]).address;
        const movableToken = MovableCollateralRouter__factory.connect(
          router,
          this.multiProvider.getSigner(chain),
        );

        const tokenApprovalTxs = Object.values(
          config.allowedRebalancingBridges ?? {},
        ).flatMap((allowedBridgesToAdd) => {
          return allowedBridgesToAdd.flatMap((bridgeToAdd) => {
            return (bridgeToAdd.approvedTokens ?? []).map((token) => {
              return {
                bridge: bridgeToAdd.bridge,
                token,
              };
            });
          });
        });

        // Find which bridges already have the required approval to avoid
        // safeApproval to fail because it requires approvals to be set to 0
        // before setting a new value
        const tokens = new Set(tokenApprovalTxs.map(({ token }) => token));
        const bridgesWithAllowanceAlreadySet: Record<
          Address,
          Set<string>
        > = Object.fromEntries(
          Array.from(tokens).map((token) => [token, new Set()]),
        );
        await Promise.all(
          tokenApprovalTxs.map(async ({ bridge, token }): Promise<void> => {
            const tokenInstance = ERC20__factory.connect(
              token,
              this.multiProvider.getSigner(chain),
            );

            const currentAllowance = await tokenInstance.allowance(
              movableToken.address,
              bridge,
            );

            if (currentAllowance.gt(0)) {
              bridgesWithAllowanceAlreadySet[token].add(bridge);
            }
          }),
        );

        const filteredTokenApprovalTxs = tokenApprovalTxs.filter(
          ({ bridge, token }) =>
            bridgesWithAllowanceAlreadySet[token] &&
            !bridgesWithAllowanceAlreadySet[token].has(bridge),
        );

        for (const bridgeConfig of filteredTokenApprovalTxs) {
          await this.multiProvider.handleTx(
            chain,
            movableToken.approveTokenForBridge(
              bridgeConfig.token,
              bridgeConfig.bridge,
            ),
          );
        }
      }),
    );
  }

  protected async setEverclearFeeParams(
    configMap: ChainMap<HypTokenConfig>,
    deployedContractsMap: HyperlaneContractsMap<Factories>,
  ): Promise<void> {
    await promiseObjAll(
      objMap(configMap, async (chain, config) => {
        if (!isEverclearTokenBridgeConfig(config)) {
          return;
        }

        const router = this.router(deployedContractsMap[chain]).address;
        const everclearTokenBridge = EverclearTokenBridge__factory.connect(
          router,
          this.multiProvider.getSigner(chain),
        );

        const resolvedFeeParamsConfig = resolveRouterMapConfig(
          this.multiProvider,
          config.everclearFeeParams,
        );

        for (const [domainId, feeConfig] of Object.entries(
          resolvedFeeParamsConfig,
        )) {
          await this.multiProvider.handleTx(
            chain,
            everclearTokenBridge.setFeeParams(
              domainId,
              feeConfig.fee,
              feeConfig.deadline,
              feeConfig.signature,
            ),
          );
        }
      }),
    );
  }

  protected async setEverclearOutputAssets(
    configMap: ChainMap<HypTokenConfig>,
    deployedContractsMap: HyperlaneContractsMap<Factories>,
  ): Promise<void> {
    await promiseObjAll(
      objMap(configMap, async (chain, config) => {
        if (!isEverclearTokenBridgeConfig(config)) {
          return;
        }

        const router = this.router(deployedContractsMap[chain]).address;
        const everclearTokenBridge = EverclearTokenBridge__factory.connect(
          router,
          this.multiProvider.getSigner(chain),
        );

        const remoteOutputAddresses = resolveRouterMapConfig(
          this.multiProvider,
          config.outputAssets,
        );

        const assets = Object.entries(remoteOutputAddresses).map(
          ([domainId, outputAsset]): {
            destination: number;
            outputAsset: string;
          } => ({
            destination: parseInt(domainId),
            outputAsset: addressToBytes32(outputAsset),
          }),
        );

        await this.multiProvider.handleTx(
          chain,
          everclearTokenBridge.setOutputAssetsBatch(assets),
        );
      }),
    );
  }

  protected async enrollRouters(
    configMap: ChainMap<HypTokenConfig>,
    deployedContractsMap: HyperlaneContractsMap<Factories>,
  ): Promise<void> {
    await promiseObjAll(
      objMap(configMap, async (chain, config) => {
        if (!isMultiCollateralTokenConfig(config)) {
          return;
        }
        if (
          !config.enrolledRouters ||
          Object.keys(config.enrolledRouters).length === 0
        ) {
          return;
        }

        const router = this.router(deployedContractsMap[chain]).address;
        const mc = MultiCollateral__factory.connect(
          router,
          this.multiProvider.getSigner(chain),
        );

        const resolvedRouters = resolveRouterMapConfig(
          this.multiProvider,
          config.enrolledRouters,
        );

        const domains: number[] = [];
        const routers: string[] = [];
        for (const [domainId, routerAddresses] of Object.entries(
          resolvedRouters,
        )) {
          for (const routerAddr of routerAddresses) {
            domains.push(Number(domainId));
            routers.push(addressToBytes32(routerAddr));
          }
        }

        if (domains.length > 0) {
          this.logger.info(
            `Batch enrolling ${domains.length} routers for ${chain}`,
          );
          await this.multiProvider.handleTx(
            chain,
            mc.enrollRouters(domains, routers),
          );
        }
      }),
    );
  }

  async deploy(configMap: WarpRouteDeployConfigMailboxRequired) {
    let tokenMetadataMap: TokenMetadataMap;
    try {
      tokenMetadataMap = await TokenDeployer.deriveTokenMetadata(
        this.multiProvider,
        configMap,
      );
    } catch (err) {
      this.logger.error('Failed to derive token metadata', err, configMap);
      throw err;
    }

    const resolvedConfigMap = await promiseObjAll(
      objMap(configMap, async (chain, config) => ({
        name: tokenMetadataMap.getName(chain),
        decimals: tokenMetadataMap.getDecimals(chain),
        symbol:
          tokenMetadataMap.getSymbol(chain) ||
          tokenMetadataMap.getDefaultSymbol(),
        scale: tokenMetadataMap.getScale(chain),
        gas: gasOverhead(config.type),
        ...config,
        // override intermediate owner to the signer
        owner: await this.multiProvider.getSigner(chain).getAddress(),
      })),
    );
    const deployedContractsMap = await super.deploy(resolvedConfigMap);

    // Configure CCTP domains after all routers are deployed and remotes are enrolled (in super.deploy)
    await this.configureCctpDomains(configMap, deployedContractsMap);

    // Set maxFeeBps for CCTP V2 routers (constructor sets it for direct deploys, this handles proxies)
    await this.configureCctpV2MaxFee(configMap, deployedContractsMap);

    await this.setRebalancers(configMap, deployedContractsMap);

    await this.setAllowedBridges(configMap, deployedContractsMap);

    await this.setBridgesTokenApprovals(configMap, deployedContractsMap);

    await this.setEverclearFeeParams(configMap, deployedContractsMap);

    await this.setEverclearOutputAssets(configMap, deployedContractsMap);

    await this.enrollRouters(configMap, deployedContractsMap);

    await super.transferOwnership(deployedContractsMap, configMap);

    return deployedContractsMap;
  }
}

export class HypERC20Deployer extends TokenDeployer<HypERC20Factories> {
  constructor(
    multiProvider: MultiProvider,
    ismFactory?: HyperlaneIsmFactory,
    contractVerifier?: ContractVerifier,
    concurrentDeploy = true,
  ) {
    super(
      multiProvider,
      hypERC20factories,
      'HypERC20Deployer',
      ismFactory,
      contractVerifier,
      concurrentDeploy,
    );
  }

  router(contracts: HyperlaneContracts<HypERC20Factories>): TokenRouter {
    for (const key of objKeys(hypERC20factories)) {
      if (contracts[key]) {
        return contracts[key] as unknown as TokenRouter;
      }
    }
    throw new Error('No matching contract found');
  }

  routerContractKey(config: HypTokenRouterConfig): keyof HypERC20Factories {
    assert(config.type in hypERC20factories, 'Invalid ERC20 token type');
    return config.type as keyof HypERC20Factories;
  }

  routerContractName(config: HypTokenRouterConfig): string {
    // Handle CCTP version-specific contract names
    if (isCctpTokenConfig(config)) {
      return `TokenBridgeCctp${config.cctpVersion}`;
    }
    return hypERC20contracts[this.routerContractKey(config)];
  }

  // Override deployContractFromFactory to handle CCTP version selection
  async deployContractFromFactory(
    chain: ChainName,
    factory: any,
    contractName: string,
    constructorArgs: any[],
    initializeArgs?: any[],
    shouldRecover = true,
    implementationAddress?: string,
  ): Promise<any> {
    // For CCTP contracts, use the version-specific factory
    if (contractName.startsWith('TokenBridgeCctp')) {
      factory = getCctpFactory(
        contractName.split('TokenBridgeCctp')[1] as 'V1' | 'V2',
      );
    }

    // Use the default deployment for other types
    return super.deployContractFromFactory(
      chain,
      factory,
      contractName,
      constructorArgs,
      initializeArgs,
      shouldRecover,
      implementationAddress,
    );
  }

  async deployAndConfigureTokenFees(
    deployedContractsMap: HyperlaneContractsMap<HypERC20Factories>,
    configMap: ChainMap<HypTokenRouterConfig>,
  ): Promise<void> {
    await Promise.all(
      Object.keys(deployedContractsMap).map(async (chain) => {
        const config = configMap[chain];
        const tokenFeeInput = config?.tokenFee;
        if (!tokenFeeInput) return;

        if (this.multiProvider.getProtocol(chain) !== ProtocolType.Ethereum) {
          this.logger.debug(`Skipping token fee on non-EVM chain ${chain}`);
          return;
        }

        const router = this.router(deployedContractsMap[chain]);
        const resolvedFeeInput = resolveTokenFeeAddress(
          tokenFeeInput,
          router.address,
          config,
        );

        this.logger.debug(`Deploying token fee on ${chain}...`);
        const processedTokenFee = await EvmTokenFeeModule.expandConfig({
          config: resolvedFeeInput,
          multiProvider: this.multiProvider,
          chainName: chain,
        });
        const module = await EvmTokenFeeModule.create({
          multiProvider: this.multiProvider,
          chain,
          config: processedTokenFee,
        });

        const { deployedFee } = module.serialize();
        const tx = await router.setFeeRecipient(deployedFee);
        await this.multiProvider.handleTx(chain, tx);
      }),
    );
  }
}

export class HypERC721Deployer extends TokenDeployer<HypERC721Factories> {
  constructor(
    multiProvider: MultiProvider,
    ismFactory?: HyperlaneIsmFactory,
    contractVerifier?: ContractVerifier,
  ) {
    super(
      multiProvider,
      hypERC721factories,
      'HypERC721Deployer',
      ismFactory,
      contractVerifier,
    );
  }

  router(contracts: HyperlaneContracts<HypERC721Factories>): GasRouter {
    for (const key of objKeys(hypERC721factories)) {
      if (contracts[key]) {
        return contracts[key];
      }
    }
    throw new Error('No matching contract found');
  }

  routerContractKey(config: HypTokenRouterConfig): keyof HypERC721Factories {
    assert(config.type in hypERC721factories, 'Invalid ERC721 token type');
    return config.type as keyof HypERC721Factories;
  }

  routerContractName(config: HypTokenRouterConfig): string {
    return hypERC721contracts[this.routerContractKey(config)];
  }
}
