import { Contract, constants, utils } from 'ethers';

import { BaseFee__factory, RoutingFee__factory } from '@hyperlane-xyz/core';
import {
  Address,
  ProtocolType,
  deepEquals,
  eqAddress,
  isNullish,
  objMap,
  objMerge,
  objOmit,
  promiseObjAll,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { transferOwnershipTransactions } from '../contracts/contracts.js';
import { HyperlaneContractsMap } from '../contracts/types.js';
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
  DerivedCrossCollateralRoutingFeeConfig,
  DEFAULT_ROUTER_KEY,
  DerivedRoutingFeeConfig,
  DerivedTokenFeeConfig,
  EvmTokenFeeReader,
  TokenFeeReaderParams,
} from './EvmTokenFeeReader.js';
import { EvmTokenFeeFactories } from './contracts.js';
import {
  ImmutableTokenFeeType,
  ResolvedTokenFeeConfigInput,
  TokenFeeConfig,
  TokenFeeConfigInput,
  TokenFeeConfigInputSchema,
  TokenFeeConfigSchema,
  OnchainTokenFeeType,
  TokenFeeType,
} from './types.js';
import { convertToBps } from './utils.js';

type TokenFeeModuleAddresses = {
  deployedFee: Address;
};

function resolveTokenForFeeConfig(
  config: TokenFeeConfigInput,
  token: Address,
): ResolvedTokenFeeConfigInput {
  if (config.type === TokenFeeType.RoutingFee && config.feeContracts) {
    return {
      ...config,
      token,
      feeContracts: Object.fromEntries(
        Object.entries(config.feeContracts).map(([chain, subFee]) => [
          chain,
          resolveTokenForFeeConfig(subFee, token),
        ]),
      ),
    };
  }
  if (
    config.type === TokenFeeType.CrossCollateralRoutingFee &&
    config.feeContracts
  ) {
    return {
      ...config,
      token,
      feeContracts: Object.fromEntries(
        Object.entries(config.feeContracts).map(
          ([chain, destinationConfig]) => [
            chain,
            {
              ...(destinationConfig.default
                ? {
                    default: resolveTokenForFeeConfig(
                      destinationConfig.default,
                      token,
                    ),
                  }
                : {}),
              ...(destinationConfig.routers
                ? {
                    routers: Object.fromEntries(
                      Object.entries(destinationConfig.routers).map(
                        ([routerKey, subFee]) => [
                          routerKey,
                          resolveTokenForFeeConfig(subFee, token),
                        ],
                      ),
                    ),
                  }
                : {}),
            },
          ],
        ),
      ),
    };
  }
  return { ...config, token };
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
    module.args.addresses.deployedFee =
      contracts[chainName][config.type].address;

    return module;
  }

  // Processes the Input config to the Final config
  // For LinearFee, it converts the bps to maxFee and halfAmount
  public static async expandConfig(params: {
    config: ResolvedTokenFeeConfigInput;
    multiProvider: MultiProvider;
    chainName: string;
  }): Promise<TokenFeeConfig> {
    const { config, multiProvider, chainName } = params;
    let intermediaryConfig: TokenFeeConfig;
    if (config.type === TokenFeeType.LinearFee) {
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

      intermediaryConfig = {
        type: TokenFeeType.LinearFee,
        token,
        owner: config.owner,
        bps,
        maxFee,
        halfAmount,
      };
    } else if (config.type === TokenFeeType.RoutingFee) {
      const { token, owner } = config;
      const feeContracts = config.feeContracts
        ? await promiseObjAll(
            objMap(
              config.feeContracts as Record<
                string,
                ResolvedTokenFeeConfigInput
              >,
              async (_, innerConfig) => {
                const resolvedInnerConfig: ResolvedTokenFeeConfigInput = {
                  ...innerConfig,
                  token: innerConfig.token ?? token,
                };
                return EvmTokenFeeModule.expandConfig({
                  config: resolvedInnerConfig,
                  multiProvider,
                  chainName,
                });
              },
            ),
          )
        : undefined;
      intermediaryConfig = {
        type: TokenFeeType.RoutingFee,
        token,
        owner,
        feeContracts,
      };
    } else if (config.type === TokenFeeType.CrossCollateralRoutingFee) {
      const { token, owner } = config;

      const feeContracts = config.feeContracts
        ? await promiseObjAll(
            objMap(config.feeContracts, async (_, destinationConfig) => {
              const defaultFee = destinationConfig.default
                ? await EvmTokenFeeModule.expandConfig({
                    config: {
                      ...destinationConfig.default,
                      token: destinationConfig.default.token ?? token,
                    },
                    multiProvider,
                    chainName,
                  })
                : undefined;
              const routers = destinationConfig.routers
                ? await promiseObjAll(
                    objMap(destinationConfig.routers, async (_, innerConfig) =>
                      EvmTokenFeeModule.expandConfig({
                        config: {
                          ...innerConfig,
                          token: innerConfig.token ?? token,
                        },
                        multiProvider,
                        chainName,
                      }),
                    ),
                  )
                : undefined;
              return {
                ...(defaultFee ? { default: defaultFee } : {}),
                ...(routers ? { routers } : {}),
              };
            }),
          )
        : undefined;

      intermediaryConfig = {
        type: TokenFeeType.CrossCollateralRoutingFee,
        token,
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

  /**
   * Updates the fee configuration to match the target config.
   *
   * IMPORTANT: This method may deploy new contracts as a side effect when:
   * - An immutable fee type (e.g., LinearFee) needs parameter changes (triggers redeploy)
   * - A new routing destination is added that doesn't have an existing sub-fee contract
   *
   * These deployments are executed immediately and are NOT included in the returned
   * transaction array. The returned transactions only include configuration changes
   * (e.g., setFeeContract, ownership transfers) that callers need to execute.
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

    let updateTransactions: AnnotatedEV5Transaction[] = [];

    // Derive routing destinations from target config if not provided.
    // Also always include CCR router keys when available.
    const crossCollateralRouters =
      targetConfig.type === TokenFeeType.CrossCollateralRoutingFee &&
      targetConfig.feeContracts
        ? Object.fromEntries(
            Object.entries(targetConfig.feeContracts).map(
              ([chainName, destinationConfig]) => [
                this.multiProvider.getDomainId(chainName),
                Object.keys(destinationConfig.routers ?? {}),
              ],
            ),
          )
        : undefined;

    let effectiveParams: Partial<TokenFeeReaderParams> = {
      ...params,
      ...(crossCollateralRouters ? { crossCollateralRouters } : {}),
    };

    if (
      !params?.routingDestinations &&
      ((targetConfig.type === TokenFeeType.RoutingFee &&
        !isNullish(targetConfig.feeContracts)) ||
        (targetConfig.type === TokenFeeType.CrossCollateralRoutingFee &&
          !isNullish(targetConfig.feeContracts)))
    ) {
      const destinations = new Set<string>(
        Object.keys(targetConfig.feeContracts ?? {}),
      );
      const routingDestinations = [...destinations].map((chainName) =>
        this.multiProvider.getDomainId(chainName),
      );
      effectiveParams = {
        ...effectiveParams,
        routingDestinations,
      };
    }

    const actualConfig = await this.read(effectiveParams);
    const normalizedActualConfig: TokenFeeConfig =
      normalizeConfig(actualConfig);

    const resolvedTargetConfig = resolveTokenForFeeConfig(
      targetConfig,
      actualConfig.token,
    );

    const normalizedTargetConfig: TokenFeeConfig = normalizeConfig(
      await EvmTokenFeeModule.expandConfig({
        config: resolvedTargetConfig,
        multiProvider: this.multiProvider,
        chainName: this.chainName,
      }),
    );

    //If configs are the same, return empty array
    if (deepEquals(normalizedActualConfig, normalizedTargetConfig)) {
      this.logger.debug(
        `Same config for ${normalizedTargetConfig.type}, no update needed`,
      );
      return [];
    }

    // Redeploy immutable fee types, if owner is the same, but the rest of the config is different
    const nonOwnerDiffers = !deepEquals(
      objOmit(normalizedActualConfig, { owner: true }),
      objOmit(normalizedTargetConfig, { owner: true }),
    );
    if (
      ImmutableTokenFeeType.includes(
        normalizedTargetConfig.type as (typeof ImmutableTokenFeeType)[number],
      ) &&
      nonOwnerDiffers
    ) {
      this.logger.info(
        `Immutable fee type ${normalizedTargetConfig.type}, redeploying`,
      );
      const contracts = await this.deploy({
        config: normalizedTargetConfig,
        multiProvider: this.multiProvider,
        chainName: this.chainName,
        contractVerifier: this.contractVerifier,
      });
      this.args.addresses.deployedFee =
        contracts[this.chainName][normalizedTargetConfig.type].address;

      return [];
    }

    let usesCrossCollateralRoutingFee = false;
    if (
      normalizedTargetConfig.type === TokenFeeType.RoutingFee ||
      normalizedTargetConfig.type === TokenFeeType.CrossCollateralRoutingFee
    ) {
      const targetUsesCrossCollateralRoutingFee =
        normalizedTargetConfig.type === TokenFeeType.CrossCollateralRoutingFee;
      const intendsRoutingConfigMutation = !isNullish(
        normalizedTargetConfig.feeContracts,
      );
      const onchainUsesCrossCollateralRoutingFee =
        await this.isCrossCollateralRoutingFeeOnchain(
          this.args.addresses.deployedFee,
        );
      if (
        intendsRoutingConfigMutation &&
        targetUsesCrossCollateralRoutingFee !==
          onchainUsesCrossCollateralRoutingFee
      ) {
        throw new Error(
          `Routing fee variant mismatch at ${this.args.addresses.deployedFee}: target expects ${targetUsesCrossCollateralRoutingFee ? 'CrossCollateralRoutingFee' : 'RoutingFee'}, on-chain is ${onchainUsesCrossCollateralRoutingFee ? 'CrossCollateralRoutingFee' : 'RoutingFee'}. Redeploy the fee contract to change variants.`,
        );
      }
      usesCrossCollateralRoutingFee = onchainUsesCrossCollateralRoutingFee;
    }

    // if the type is a mutable (for now, only routing fee), then update
    updateTransactions = [
      ...(await this.updateRoutingFee(
        objMerge(actualConfig, normalizedTargetConfig, 10, true) as
          | DerivedRoutingFeeConfig
          | DerivedCrossCollateralRoutingFeeConfig,
        usesCrossCollateralRoutingFee,
      )),
      ...this.createOwnershipUpdateTxs(
        normalizedActualConfig,
        normalizedTargetConfig,
      ),
    ];

    return updateTransactions;
  }

  private async updateRoutingFee(
    targetConfig:
      | DerivedRoutingFeeConfig
      | DerivedCrossCollateralRoutingFeeConfig,
    isCrossCollateralRoutingFee = false,
  ) {
    const updateTransactions: AnnotatedEV5Transaction[] = [];
    const ccrfDestinations: number[] = [];
    const ccrfRouters: string[] = [];
    const ccrfFeeContracts: string[] = [];

    if (!targetConfig.feeContracts) return [];
    const currentRoutingAddress = this.args.addresses.deployedFee;
    const ccrfInterface = new utils.Interface([
      'function setCrossCollateralRouterFeeContracts(uint32[],bytes32[],address[])',
    ]);
    const destinationFeeConfigs = new Map<
      string,
      {
        chainName: string;
        routerKey: string;
        config: DerivedTokenFeeConfig;
      }
    >();
    const setDestinationConfig = (
      chainName: string,
      routerKey: string,
      config: DerivedTokenFeeConfig,
      source: 'feeContracts',
    ) => {
      const entryKey = `${chainName}:${routerKey}`;
      const existing = destinationFeeConfigs.get(entryKey);
      if (!existing) {
        destinationFeeConfigs.set(entryKey, { chainName, routerKey, config });
        return;
      }

      if (
        !deepEquals(normalizeConfig(existing.config), normalizeConfig(config))
      ) {
        throw new Error(
          `Conflicting routing fee sub-config for ${entryKey} between ${source} and existing entry`,
        );
      }
    };

    if (isCrossCollateralRoutingFee) {
      const ccrfFeeContracts = (
        targetConfig as DerivedCrossCollateralRoutingFeeConfig
      ).feeContracts;
      for (const [chainName, destinationConfig] of Object.entries(
        ccrfFeeContracts,
      )) {
        if (destinationConfig.default) {
          setDestinationConfig(
            chainName,
            DEFAULT_ROUTER_KEY,
            destinationConfig.default,
            'feeContracts',
          );
        }
        for (const [routerKey, routerConfig] of Object.entries(
          destinationConfig.routers ?? {},
        )) {
          setDestinationConfig(
            chainName,
            routerKey,
            routerConfig,
            'feeContracts',
          );
        }
      }
    } else {
      const routingFeeContracts = (targetConfig as DerivedRoutingFeeConfig)
        .feeContracts;
      for (const [chainName, config] of Object.entries(routingFeeContracts)) {
        setDestinationConfig(
          chainName,
          DEFAULT_ROUTER_KEY,
          config,
          'feeContracts',
        );
      }
    }

    for (const {
      chainName,
      routerKey,
      config,
    } of destinationFeeConfigs.values()) {
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

        const annotation = `New sub fee contract deployed. Setting contract for ${chainName} (${routerKey}) to ${deployedSubFee}`;
        this.logger.debug(annotation);
        if (isCrossCollateralRoutingFee) {
          ccrfDestinations.push(this.multiProvider.getDomainId(chainName));
          ccrfRouters.push(routerKey);
          ccrfFeeContracts.push(deployedSubFee);
        } else if (routerKey === DEFAULT_ROUTER_KEY) {
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
          throw new Error(
            `Router-specific fee contract update (${routerKey}) requires CrossCollateralRoutingFee`,
          );
        }
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
          const annotation = `Sub fee contract redeployed on chain ${this.chainName}. Updating fee contract for destination ${chainName} (${routerKey}) to ${deployedSubFee}`;
          this.logger.debug(annotation);
          if (isCrossCollateralRoutingFee) {
            ccrfDestinations.push(this.multiProvider.getDomainId(chainName));
            ccrfRouters.push(routerKey);
            ccrfFeeContracts.push(deployedSubFee);
          } else if (routerKey === DEFAULT_ROUTER_KEY) {
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
            throw new Error(
              `Router-specific fee contract update (${routerKey}) requires CrossCollateralRoutingFee`,
            );
          }
        }
      }
    }

    if (isCrossCollateralRoutingFee && ccrfDestinations.length > 0) {
      updateTransactions.push({
        annotation: `Updating CrossCollateralRoutingFee contracts for ${ccrfDestinations.length} destination(s)`,
        chainId: this.chainId,
        to: currentRoutingAddress,
        data: ccrfInterface.encodeFunctionData(
          'setCrossCollateralRouterFeeContracts',
          [ccrfDestinations, ccrfRouters, ccrfFeeContracts],
        ),
      });
    }

    return updateTransactions;
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

  private async isCrossCollateralRoutingFeeOnchain(
    address: Address,
  ): Promise<boolean> {
    const provider = this.multiProvider.getProvider(this.chainName);
    const tokenFee = BaseFee__factory.connect(address, provider);
    try {
      const feeType = await tokenFee.feeType();
      return feeType === OnchainTokenFeeType.CrossCollateralRoutingFee;
    } catch {
      const maybeCcrf = new Contract(
        address,
        ['function DEFAULT_ROUTER() view returns (bytes32)'],
        provider,
      );
      const defaultRouter = await maybeCcrf.DEFAULT_ROUTER().catch(() => null);
      return defaultRouter === DEFAULT_ROUTER_KEY;
    }
  }
}
