import { constants } from 'ethers';

import {
  OffchainQuotedLinearFee__factory,
  RoutingFee__factory,
} from '@hyperlane-xyz/core';
import {
  Address,
  ProtocolType,
  deepEquals,
  difference,
  eqAddress,
  objMap,
  objMerge,
  objOmit,
  promiseObjAll,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { transferOwnershipTransactions } from '../contracts/contracts.js';
import {
  HyperlaneContracts,
  HyperlaneContractsMap,
} from '../contracts/types.js';
import {
  HyperlaneModule,
  HyperlaneModuleParams,
} from '../core/AbstractHyperlaneModule.js';
import { ContractVerifier } from '../deploy/verify/ContractVerifier.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { AnnotatedEV5Transaction } from '../providers/ProviderType.js';
import { ChainNameOrId } from '../types.js';
import { normalizeConfig } from '../utils/ism.js';

import { EvmTokenFeeDeployer } from './EvmTokenFeeDeployer.js';
import {
  DerivedRoutingFeeConfig,
  DerivedTokenFeeConfig,
  EvmTokenFeeReader,
  TokenFeeReaderParams,
} from './EvmTokenFeeReader.js';
import {
  getConfiguredCrossCollateralRouters,
  getConfiguredRoutingDestinations,
  mergeCrossCollateralRouters,
} from './crossCollateralUtils.js';
import { EvmTokenFeeFactories } from './contracts.js';
import {
  ResolvedCrossCollateralRoutingFeeConfigInput,
  ResolvedTokenFeeConfigInput,
  TokenFeeConfig,
  TokenFeeConfigInput,
  TokenFeeConfigInputSchema,
  TokenFeeConfigSchema,
  TokenFeeType,
} from './types.js';
import { convertToBps } from './utils.js';

type TokenFeeModuleAddresses = {
  deployedFee: Address;
};

function getDeployedFeeAddress(
  contracts: HyperlaneContracts<EvmTokenFeeFactories>,
  feeType: TokenFeeType,
): Address {
  switch (feeType) {
    case TokenFeeType.LinearFee:
      return contracts.LinearFee.address;
    case TokenFeeType.ProgressiveFee:
      return contracts.ProgressiveFee.address;
    case TokenFeeType.RegressiveFee:
      return contracts.RegressiveFee.address;
    case TokenFeeType.RoutingFee:
      return contracts.RoutingFee.address;
    case TokenFeeType.CrossCollateralRoutingFee:
      return contracts.CrossCollateralRoutingFee.address;
    case TokenFeeType.OffchainQuotedLinearFee:
      return contracts.OffchainQuotedLinearFee.address;
  }
}

function getResolvedFeeToken(
  config: TokenFeeConfigInput | ResolvedTokenFeeConfigInput | TokenFeeConfig,
  fallbackToken?: Address,
): Address | undefined {
  return 'token' in config && typeof config.token === 'string'
    ? config.token
    : fallbackToken;
}

function getFallbackTokenFromFeeConfig(
  config: TokenFeeConfigInput | ResolvedTokenFeeConfigInput | TokenFeeConfig,
): Address | undefined {
  const directToken = getResolvedFeeToken(config);
  if (directToken) return directToken;

  if (config.type === TokenFeeType.RoutingFee) {
    return Object.values(config.feeContracts)
      .map(getFallbackTokenFromFeeConfig)
      .find(Boolean);
  }

  if (config.type === TokenFeeType.CrossCollateralRoutingFee) {
    return Object.values(config.feeContracts)
      .flatMap((destinationConfig) => Object.values(destinationConfig))
      .map(getFallbackTokenFromFeeConfig)
      .find(Boolean);
  }

  return undefined;
}

function requireResolvedFeeToken(
  config: TokenFeeConfigInput | ResolvedTokenFeeConfigInput | TokenFeeConfig,
  fallbackToken?: Address,
): Address {
  const resolvedToken = getResolvedFeeToken(config, fallbackToken);
  if (!resolvedToken) {
    throw new Error(
      `Token is required to resolve ${config.type} fee config children`,
    );
  }
  return resolvedToken;
}

function resolveTokenForFeeConfig(
  config: TokenFeeConfigInput,
  fallbackToken?: Address,
): ResolvedTokenFeeConfigInput {
  if (config.type === TokenFeeType.RoutingFee) {
    const resolvedToken = requireResolvedFeeToken(config, fallbackToken);
    return {
      ...config,
      token: resolvedToken,
      feeContracts: Object.fromEntries(
        Object.entries(config.feeContracts).map(([chain, subFee]) => [
          chain,
          resolveTokenForFeeConfig(subFee, resolvedToken),
        ]),
      ),
    };
  }
  if (config.type === TokenFeeType.CrossCollateralRoutingFee) {
    const nestedFallbackToken = getResolvedFeeToken(config, fallbackToken);
    return {
      ...config,
      feeContracts: objMap(config.feeContracts, (_, destinationConfig) =>
        objMap(destinationConfig, (_, subFee) =>
          resolveTokenForFeeConfig(subFee, nestedFallbackToken),
        ),
      ),
    } as ResolvedCrossCollateralRoutingFeeConfigInput;
  }
  return {
    ...config,
    token: requireResolvedFeeToken(config, fallbackToken),
  };
}

export class EvmTokenFeeModule extends HyperlaneModule<
  ProtocolType.Ethereum,
  TokenFeeConfigInput,
  TokenFeeModuleAddresses
> {
  static protocols = [ProtocolType.Ethereum, ProtocolType.Tron];
  protected readonly logger = rootLogger.child({ module: 'EvmTokenFeeModule' });
  protected readonly deployer: EvmTokenFeeDeployer;
  protected readonly reader: EvmTokenFeeReader;
  protected readonly chainName: string;
  protected readonly chainId: number;
  constructor(
    protected readonly multiProvider: MultiProvider,
    params: HyperlaneModuleParams<TokenFeeConfigInput, TokenFeeModuleAddresses>,
    protected readonly contractVerifier?: ContractVerifier,
  ) {
    super(params);
    this.chainName = multiProvider.getChainName(params.chain);
    this.chainId = multiProvider.getDomainId(this.chainName);

    this.deployer = new EvmTokenFeeDeployer(multiProvider, this.chainName, {
      logger: this.logger,
      contractVerifier: contractVerifier,
    });
    this.reader = new EvmTokenFeeReader(multiProvider, this.chainName);
  }

  static async create({
    multiProvider,
    chain,
    config,
    contractVerifier,
  }: {
    multiProvider: MultiProvider;
    chain: ChainNameOrId;
    config: TokenFeeConfig;
    contractVerifier?: ContractVerifier;
  }): Promise<EvmTokenFeeModule> {
    const chainName = multiProvider.getChainName(chain);
    const module = new EvmTokenFeeModule(
      multiProvider,
      {
        addresses: {
          deployedFee: constants.AddressZero,
        },
        chain,
        config,
      },
      contractVerifier,
    );

    const contracts = await module.deploy({
      multiProvider,
      chainName,
      contractVerifier,
      config,
    });
    module.args.addresses.deployedFee = getDeployedFeeAddress(
      contracts[chainName],
      config.type,
    );

    return module;
  }

  // Processes the Input config to the Final config
  // For LinearFee/OffchainQuotedLinearFee, it converts the bps to maxFee and halfAmount
  public static async expandConfig(params: {
    config: ResolvedTokenFeeConfigInput;
    multiProvider: MultiProvider;
    chainName: string;
  }): Promise<TokenFeeConfig> {
    const { config, multiProvider, chainName } = params;
    let intermediaryConfig: TokenFeeConfig;
    if (
      config.type === TokenFeeType.LinearFee ||
      config.type === TokenFeeType.OffchainQuotedLinearFee
    ) {
      const { token } = config;

      let maxFee: bigint;
      let halfAmount: bigint;
      let bps: bigint;

      const reader = new EvmTokenFeeReader(
        params.multiProvider,
        params.chainName,
      );

      // Determine which values to use:
      // - If maxFee/halfAmount are provided and bps matches what you'd compute from them,
      //   the user provided explicit values (bps was auto-computed by schema) - use them
      // - If bps doesn't match, the user explicitly provided a different bps - use bps
      // - If only bps is provided, derive maxFee/halfAmount from bps
      if (config.maxFee !== undefined && config.halfAmount !== undefined) {
        const explicitMaxFee = BigInt(config.maxFee);
        const explicitHalfAmount = BigInt(config.halfAmount);
        const computedBps = convertToBps(explicitMaxFee, explicitHalfAmount);

        if (config.bps === undefined || config.bps === computedBps) {
          // bps was auto-computed or matches - use explicit values
          maxFee = explicitMaxFee;
          halfAmount = explicitHalfAmount;
          bps = computedBps;
        } else {
          // User explicitly provided a different bps - use bps-derived values
          const derived = reader.convertFromBps(config.bps);
          maxFee = derived.maxFee;
          halfAmount = derived.halfAmount;
          bps = config.bps;
        }
      } else if (config.bps !== undefined) {
        const derived = reader.convertFromBps(config.bps);
        maxFee = derived.maxFee;
        halfAmount = derived.halfAmount;
        bps = config.bps;
      } else {
        throw new Error(
          'LinearFee config must provide either bps or both maxFee and halfAmount',
        );
      }

      if (config.type === TokenFeeType.OffchainQuotedLinearFee) {
        intermediaryConfig = {
          type: TokenFeeType.OffchainQuotedLinearFee,
          token,
          owner: config.owner,
          bps,
          maxFee,
          halfAmount,
          quoteSigners: config.quoteSigners,
        };
      } else {
        intermediaryConfig = {
          type: TokenFeeType.LinearFee,
          token,
          owner: config.owner,
          bps,
          maxFee,
          halfAmount,
        };
      }
    } else if (config.type === TokenFeeType.RoutingFee) {
      const { token, owner } = config;
      const feeContracts = await promiseObjAll(
        objMap(config.feeContracts, async (_, innerConfig) => {
          return EvmTokenFeeModule.expandConfig({
            config: resolveTokenForFeeConfig(
              innerConfig,
              ('token' in innerConfig ? innerConfig.token : undefined) ?? token,
            ),
            multiProvider,
            chainName,
          });
        }),
      );
      intermediaryConfig = {
        type: TokenFeeType.RoutingFee,
        token,
        owner,
        feeContracts,
      };
    } else if (config.type === TokenFeeType.CrossCollateralRoutingFee) {
      const { owner } = config;

      const feeContracts = await promiseObjAll(
        objMap(config.feeContracts, async (_, destinationConfig) => {
          return promiseObjAll(
            objMap(destinationConfig, async (_, innerConfig) =>
              EvmTokenFeeModule.expandConfig({
                config: innerConfig,
                multiProvider,
                chainName,
              }),
            ),
          );
        }),
      );

      intermediaryConfig = {
        type: TokenFeeType.CrossCollateralRoutingFee,
        owner,
        feeContracts,
      };
    } else {
      // Progressive/Regressive fees
      intermediaryConfig = {
        ...config,
        maxFee: BigInt(config.maxFee),
        halfAmount: BigInt(config.halfAmount),
      };
    }

    return TokenFeeConfigSchema.parse(intermediaryConfig);
  }

  private async deploy(params: {
    config: TokenFeeConfig;
    multiProvider: MultiProvider;
    chainName: string;
    contractVerifier?: ContractVerifier;
  }): Promise<HyperlaneContractsMap<EvmTokenFeeFactories>> {
    const deployer = new EvmTokenFeeDeployer(
      params.multiProvider,
      params.chainName,
      {
        contractVerifier: params.contractVerifier,
      },
    );
    return deployer.deploy({ [params.chainName]: params.config });
  }

  async read(
    params?: Partial<TokenFeeReaderParams>,
  ): Promise<DerivedTokenFeeConfig> {
    const address = params?.address ?? this.args.addresses.deployedFee;
    const routingDestinations = params?.routingDestinations;

    return this.reader.deriveTokenFeeConfig({
      address,
      routingDestinations,
      crossCollateralRouters: params?.crossCollateralRouters,
    });
  }

  // Routing-fee diffs need enough read context to observe every configured
  // destination plus any caller-specified CCR router hints for stale entries.
  private deriveReadParams(
    targetConfig: TokenFeeConfigInput,
    params?: Partial<TokenFeeReaderParams>,
  ): Partial<TokenFeeReaderParams> {
    const effectiveParams: Partial<TokenFeeReaderParams> = { ...params };

    if (
      (targetConfig.type === TokenFeeType.RoutingFee ||
        targetConfig.type === TokenFeeType.CrossCollateralRoutingFee) &&
      !effectiveParams.routingDestinations
    ) {
      effectiveParams.routingDestinations = getConfiguredRoutingDestinations(
        targetConfig.feeContracts,
        (chainName) => this.multiProvider.getDomainId(chainName),
      );
    }

    if (targetConfig.type !== TokenFeeType.CrossCollateralRoutingFee) {
      return effectiveParams;
    }

    const targetCrossCollateralRouters = getConfiguredCrossCollateralRouters(
      targetConfig.feeContracts,
      (chainName) => this.multiProvider.getDomainId(chainName),
    );
    effectiveParams.crossCollateralRouters = mergeCrossCollateralRouters(
      effectiveParams.crossCollateralRouters,
      targetCrossCollateralRouters,
    );
    return effectiveParams;
  }

  private shouldRedeploy(
    actualConfig: TokenFeeConfig,
    targetConfig: TokenFeeConfig,
  ): boolean {
    if (actualConfig.type !== targetConfig.type) return true;

    // OffchainQuotedLinearFee: fee params are immutable, but signers are mutable
    const mutableFields =
      targetConfig.type === TokenFeeType.OffchainQuotedLinearFee
        ? { owner: true, quoteSigners: true }
        : { owner: true };

    return !deepEquals(
      objOmit(actualConfig, mutableFields),
      objOmit(targetConfig, mutableFields),
    );
  }

  /**
   * Updates the fee configuration to match the target config.
   *
   * IMPORTANT: This method may deploy new contracts as a side effect when:
   * - Any non-owner diff is detected (triggers redeploy)
   *
   * These deployments are executed immediately and are NOT included in the returned
   * transaction array. The returned transactions only include configuration changes
   * (ownership transfers) that callers need to execute.
   *
   * This behavior is consistent with other Hyperlane SDK modules (EvmIsmModule, EvmHookModule).
   *
   * @param targetConfig - The desired fee configuration
   * @param params - Optional parameters including routingDestinations for reading sub-fees.
   *                 If not provided for RoutingFee configs, destinations are derived from
   *                 targetConfig.feeContracts keys.
   * @returns Transactions to execute for configuration updates (does not include deployments)
   */
  async update(
    targetConfig: TokenFeeConfigInput,
    params?: Partial<TokenFeeReaderParams>,
  ): Promise<AnnotatedEV5Transaction[]> {
    TokenFeeConfigInputSchema.parse(targetConfig);

    const actualConfig = await this.read(
      this.deriveReadParams(targetConfig, params),
    );
    const normalizedActualConfig: TokenFeeConfig =
      normalizeConfig(actualConfig);

    const resolvedTargetConfig = resolveTokenForFeeConfig(
      targetConfig,
      getFallbackTokenFromFeeConfig(actualConfig),
    );

    const normalizedTargetConfig: TokenFeeConfig = normalizeConfig(
      await EvmTokenFeeModule.expandConfig({
        config: resolvedTargetConfig,
        multiProvider: this.multiProvider,
        chainName: this.chainName,
      }),
    );

    if (deepEquals(normalizedActualConfig, normalizedTargetConfig)) {
      this.logger.debug(
        `Same config for ${normalizedTargetConfig.type}, no update needed`,
      );
      return [];
    }

    if (this.shouldRedeploy(normalizedActualConfig, normalizedTargetConfig)) {
      this.logger.info(
        `Redeploying ${normalizedTargetConfig.type} due to non-owner config diff`,
      );
      const contracts = await this.deploy({
        config: normalizedTargetConfig,
        multiProvider: this.multiProvider,
        chainName: this.chainName,
        contractVerifier: this.contractVerifier,
      });
      this.args.addresses.deployedFee = getDeployedFeeAddress(
        contracts[this.chainName],
        normalizedTargetConfig.type,
      );

      return [];
    }

    // OffchainQuotedLinearFee: signers are mutable (fee params handled by shouldRedeploy)
    if (
      normalizedTargetConfig.type === TokenFeeType.OffchainQuotedLinearFee &&
      normalizedActualConfig.type === TokenFeeType.OffchainQuotedLinearFee
    ) {
      return [
        ...this.createQuoteSignerUpdateTxs(
          normalizedActualConfig.quoteSigners,
          normalizedTargetConfig.quoteSigners,
        ),
        ...this.createOwnershipUpdateTxs(
          normalizedActualConfig,
          normalizedTargetConfig,
        ),
      ];
    }

    // Routing fee: update sub-fee contracts
    if (
      normalizedTargetConfig.type === TokenFeeType.RoutingFee &&
      normalizedActualConfig.type === TokenFeeType.RoutingFee
    ) {
      return [
        ...(await this.updateRoutingFee(
          objMerge(
            actualConfig,
            normalizedTargetConfig,
            10,
            true,
          ) as DerivedRoutingFeeConfig,
        )),
        ...this.createOwnershipUpdateTxs(
          normalizedActualConfig,
          normalizedTargetConfig,
        ),
      ];
    }

    return this.createOwnershipUpdateTxs(
      normalizedActualConfig,
      normalizedTargetConfig,
    );
  }

  private async updateRoutingFee(targetConfig: DerivedRoutingFeeConfig) {
    const updateTransactions: AnnotatedEV5Transaction[] = [];

    if (!targetConfig.feeContracts) return [];
    const currentRoutingAddress = this.args.addresses.deployedFee;
    for (const [chainName, config] of Object.entries(
      targetConfig.feeContracts,
    )) {
      const address = config.address;

      let subFeeModule: EvmTokenFeeModule;
      let deployedSubFee: string;

      if (!address) {
        // Sub-fee contract doesn't exist yet, deploy a new one
        this.logger.info(
          `No existing sub-fee contract for ${chainName}, deploying new one`,
        );
        subFeeModule = await EvmTokenFeeModule.create({
          multiProvider: this.multiProvider,
          chain: this.chainName,
          config,
          contractVerifier: this.contractVerifier,
        });
        deployedSubFee = subFeeModule.serialize().deployedFee;

        const annotation = `New sub fee contract deployed. Setting contract for ${chainName} to ${deployedSubFee}`;
        this.logger.debug(annotation);
        updateTransactions.push({
          annotation: annotation,
          chainId: this.chainId,
          to: currentRoutingAddress,
          data: RoutingFee__factory.createInterface().encodeFunctionData(
            'setFeeContract(uint32,address)',
            [this.multiProvider.getDomainId(chainName), deployedSubFee],
          ),
        });
      } else {
        // Update existing sub-fee contract
        subFeeModule = new EvmTokenFeeModule(
          this.multiProvider,
          {
            addresses: {
              deployedFee: address,
            },
            chain: this.chainName,
            config,
          },
          this.contractVerifier,
        );
        const subFeeUpdateTransactions = await subFeeModule.update(config, {
          address,
        });
        deployedSubFee = subFeeModule.serialize().deployedFee;

        updateTransactions.push(...subFeeUpdateTransactions);

        if (!eqAddress(deployedSubFee, address)) {
          const annotation = `Sub fee contract redeployed on chain ${this.chainName}. Updating fee contract for destination ${chainName} to ${deployedSubFee}`;
          this.logger.debug(annotation);
          updateTransactions.push({
            annotation: annotation,
            chainId: this.chainId,
            to: currentRoutingAddress,
            data: RoutingFee__factory.createInterface().encodeFunctionData(
              'setFeeContract(uint32,address)',
              [this.multiProvider.getDomainId(chainName), deployedSubFee],
            ),
          });
        }
      }
    }

    return updateTransactions;
  }

  private createQuoteSignerUpdateTxs(
    actualSigners: string[] | undefined,
    targetSigners: string[] | undefined,
  ): AnnotatedEV5Transaction[] {
    const txs: AnnotatedEV5Transaction[] = [];
    const iface = OffchainQuotedLinearFee__factory.createInterface();
    const contractAddress = this.args.addresses.deployedFee;

    const actualSet = new Set(
      (actualSigners ?? []).map((s) => s.toLowerCase()),
    );
    const targetSet = new Set(
      (targetSigners ?? []).map((s) => s.toLowerCase()),
    );

    for (const signer of difference(targetSet, actualSet)) {
      txs.push({
        annotation: `Add quote signer ${signer}`,
        chainId: this.chainId,
        to: contractAddress,
        data: iface.encodeFunctionData('addQuoteSigner', [signer]),
      });
    }

    for (const signer of difference(actualSet, targetSet)) {
      txs.push({
        annotation: `Remove quote signer ${signer}`,
        chainId: this.chainId,
        to: contractAddress,
        data: iface.encodeFunctionData('removeQuoteSigner', [signer]),
      });
    }

    return txs;
  }

  private createOwnershipUpdateTxs(
    actualConfig: TokenFeeConfig,
    expectedConfig: TokenFeeConfig,
  ): AnnotatedEV5Transaction[] {
    return transferOwnershipTransactions(
      this.multiProvider.getEvmChainId(this.args.chain),
      this.args.addresses.deployedFee,
      actualConfig,
      expectedConfig,
      `${expectedConfig.type} Warp Route`,
    );
  }
}
