import { constants } from 'ethers';

import { RoutingFee__factory } from '@hyperlane-xyz/core';
import {
  Address,
  ProtocolType,
  assert,
  deepEquals,
  eqAddress,
  isZeroishAddress,
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
  TokenFeeConfig,
  TokenFeeConfigInput,
  TokenFeeConfigSchema,
  TokenFeeType,
} from './types.js';

type TokenFeeModuleAddresses = {
  deployedFee: Address;
};

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
    config: TokenFeeConfigInput;
    multiProvider: MultiProvider;
    chainName: string;
  }): Promise<TokenFeeConfig> {
    const { config, multiProvider, chainName } = params;
    let intermediaryConfig: TokenFeeConfig;
    if (config.type === TokenFeeType.LinearFee) {
      const reader = new EvmTokenFeeReader(
        params.multiProvider,
        params.chainName,
      );

      let { maxFee, halfAmount } = config;

      if (!isZeroishAddress(config.token)) {
        const { maxFee: convertedMaxFee, halfAmount: convertedHalfAmount } =
          await reader.convertFromBps(config.bps, config.token);
        maxFee = convertedMaxFee;
        halfAmount = convertedHalfAmount;
      }

      assert(
        maxFee && halfAmount,
        'Config properties "maxFee" and "halfAmount" must be supplied when "token" is not supplied',
      );

      intermediaryConfig = {
        type: TokenFeeType.LinearFee,
        token: config.token,
        owner: config.owner,
        bps: config.bps,
        maxFee,
        halfAmount,
      };
    } else if (config.type === TokenFeeType.RoutingFee) {
      const feeContracts = config.feeContracts
        ? await promiseObjAll(
            objMap(config.feeContracts, async (_, innerConfig) => {
              return EvmTokenFeeModule.expandConfig({
                config: innerConfig,
                multiProvider,
                chainName,
              });
            }),
          )
        : undefined;

      intermediaryConfig = {
        type: TokenFeeType.RoutingFee,
        token: config.token,
        owner: config.owner,
        maxFee: constants.MaxUint256.toBigInt(),
        halfAmount: constants.MaxUint256.toBigInt(),
        feeContracts,
      };
    } else {
      intermediaryConfig = config;
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

  async update(
    targetConfig: TokenFeeConfigInput,
    params?: Partial<TokenFeeReaderParams>,
  ): Promise<AnnotatedEV5Transaction[]> {
    let updateTransactions: AnnotatedEV5Transaction[] = [];

    const normalizedTargetConfig: TokenFeeConfig = normalizeConfig(
      await EvmTokenFeeModule.expandConfig({
        config: targetConfig,
        multiProvider: this.multiProvider,
        chainName: this.chainName,
      }),
    );

    // Derive routingDestinations from target config's feeContracts if not provided
    let routingDestinations = params?.routingDestinations;
    if (
      !routingDestinations &&
      normalizedTargetConfig.type === TokenFeeType.RoutingFee &&
      normalizedTargetConfig.feeContracts
    ) {
      routingDestinations = Object.keys(
        normalizedTargetConfig.feeContracts,
      ).map((chainName) => this.multiProvider.getDomainId(chainName));
    }

    const actualConfig = await this.read({
      ...params,
      routingDestinations,
    });
    const normalizedActualConfig: TokenFeeConfig =
      normalizeConfig(actualConfig);

    //If configs are the same, return empty array
    if (deepEquals(normalizedActualConfig, normalizedTargetConfig)) {
      this.logger.debug(
        `Same config for ${normalizedTargetConfig.type}, no update needed`,
      );
      return [];
    }

    // Redeploy if fee type changes or if immutable fee type config differs (excluding owner)
    const feeTypeChanged =
      normalizedActualConfig.type !== normalizedTargetConfig.type;

    // For LinearFee with bps defined, compare bps instead of derived maxFee/halfAmount.
    // maxFee is computed as: uint256.max / token.totalSupply()
    // Since totalSupply changes over time (e.g., USDC mints/burns), computed values
    // will differ from on-chain values even when the fee rate (bps) is identical.
    // Only apply this optimization when both configs have bps; otherwise fall back
    // to comparing maxFee/halfAmount directly.
    const isLinearFeeWithBps =
      normalizedActualConfig.type === TokenFeeType.LinearFee &&
      normalizedTargetConfig.type === TokenFeeType.LinearFee &&
      'bps' in normalizedActualConfig &&
      'bps' in normalizedTargetConfig &&
      normalizedActualConfig.bps !== undefined &&
      normalizedTargetConfig.bps !== undefined;

    const fieldsToOmit = isLinearFeeWithBps
      ? { owner: true, maxFee: true, halfAmount: true }
      : { owner: true };

    const actualForComparison = objOmit(normalizedActualConfig, fieldsToOmit);
    const targetForComparison = objOmit(normalizedTargetConfig, fieldsToOmit);
    const nonOwnerDiffers = !deepEquals(
      actualForComparison,
      targetForComparison,
    );
    const isTargetImmutable = ImmutableTokenFeeType.includes(
      normalizedTargetConfig.type as (typeof ImmutableTokenFeeType)[number],
    );

    if (feeTypeChanged || (isTargetImmutable && nonOwnerDiffers)) {
      this.logger.info(
        feeTypeChanged
          ? `Fee type changed from ${normalizedActualConfig.type} to ${normalizedTargetConfig.type}, redeploying`
          : `Immutable fee type ${normalizedTargetConfig.type}, redeploying`,
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

    // Deduplicate transactions (e.g., when multiple destinations share the same sub-contract)
    return this.deduplicateTransactions(updateTransactions);
  }

  private async updateRoutingFee(targetConfig: DerivedRoutingFeeConfig) {
    const updateTransactions: AnnotatedEV5Transaction[] = [];

    if (!targetConfig.feeContracts) return [];
    const currentRoutingAddress = this.args.addresses.deployedFee;
    await promiseObjAll(
      objMap(targetConfig.feeContracts, async (chainName, config) => {
        const address = config.address;
        const subFeeModule = new EvmTokenFeeModule(
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
        const { deployedFee: deployedSubFee } = subFeeModule.serialize();

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

  /**
   * Deduplicate transactions based on chainId + to + data.
   * This handles cases where multiple destinations share the same sub-contract,
   * which would otherwise generate duplicate ownership transfer transactions.
   */
  private deduplicateTransactions(
    transactions: AnnotatedEV5Transaction[],
  ): AnnotatedEV5Transaction[] {
    const seen = new Set<string>();
    return transactions.filter((tx) => {
      const key = `${tx.chainId}-${tx.to?.toLowerCase()}-${tx.data}`;
      if (seen.has(key)) {
        this.logger.debug(
          `Deduplicating transaction: ${tx.annotation ?? 'unknown'}`,
        );
        return false;
      }
      seen.add(key);
      return true;
    });
  }
}
