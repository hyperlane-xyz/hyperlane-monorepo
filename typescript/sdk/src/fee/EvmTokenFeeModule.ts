import { constants } from 'ethers';

import { RoutingFee__factory } from '@hyperlane-xyz/core';
import {
  Address,
  ProtocolType,
  deepEquals,
  eqAddress,
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
  if (
    config.type === TokenFeeType.RoutingFee &&
    'feeContracts' in config &&
    config.feeContracts
  ) {
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
  return { ...config, token };
}

export class EvmTokenFeeModule extends HyperlaneModule<
  ProtocolType.Ethereum,
  TokenFeeConfigInput,
  TokenFeeModuleAddresses
> {
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
      const inputFeeContracts =
        'feeContracts' in config ? config.feeContracts : undefined;

      const feeContracts = inputFeeContracts
        ? await promiseObjAll(
            objMap(
              inputFeeContracts as Record<string, ResolvedTokenFeeConfigInput>,
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
        maxFee: constants.MaxUint256.toBigInt(),
        halfAmount: constants.MaxUint256.toBigInt(),
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
      address: address,
      routingDestinations,
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

    // Derive routingDestinations from target config if not provided
    // This ensures we read all sub-fee configs that need to be compared/updated
    let effectiveParams = params;
    if (
      !params?.routingDestinations &&
      targetConfig.type === TokenFeeType.RoutingFee &&
      'feeContracts' in targetConfig &&
      targetConfig.feeContracts
    ) {
      const routingDestinations = Object.keys(targetConfig.feeContracts).map(
        (chainName) => this.multiProvider.getDomainId(chainName),
      );
      effectiveParams = { ...params, routingDestinations };
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

    // if the type is a mutable (for now, only routing fee), then update
    updateTransactions = [
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

    return updateTransactions;
  }

  private async updateRoutingFee(targetConfig: DerivedRoutingFeeConfig) {
    const updateTransactions: AnnotatedEV5Transaction[] = [];

    if (!targetConfig.feeContracts) return [];
    const currentRoutingAddress = this.args.addresses.deployedFee;
    await promiseObjAll(
      objMap(targetConfig.feeContracts, async (chainName, config) => {
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
            const annotation = `Sub fee contract redeployed. Updating contract for ${chainName} to ${deployedSubFee}`;
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
      }),
    );

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
}
