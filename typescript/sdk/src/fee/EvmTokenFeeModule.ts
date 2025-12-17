import { constants } from 'ethers';

import { RoutingFee__factory } from '@hyperlane-xyz/core';
import {
  type Address,
  type ProtocolType,
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
import { type HyperlaneContractsMap } from '../contracts/types.js';
import {
  HyperlaneModule,
  type HyperlaneModuleParams,
} from '../core/AbstractHyperlaneModule.js';
import { type ContractVerifier } from '../deploy/verify/ContractVerifier.js';
import { type MultiProvider } from '../providers/MultiProvider.js';
import { type AnnotatedEV5Transaction } from '../providers/ProviderType.js';
import { type ChainNameOrId } from '../types.js';
import { normalizeConfig } from '../utils/ism.js';

import { EvmTokenFeeDeployer } from './EvmTokenFeeDeployer.js';
import {
  type DerivedRoutingFeeConfig,
  type DerivedTokenFeeConfig,
  EvmTokenFeeReader,
  type TokenFeeReaderParams,
} from './EvmTokenFeeReader.js';
import { type EvmTokenFeeFactories } from './contracts.js';
import {
  ImmutableTokenFeeType,
  type TokenFeeConfig,
  type TokenFeeConfigInput,
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

    const actualConfig = await this.read(params);
    const normalizedActualConfig: TokenFeeConfig =
      normalizeConfig(actualConfig);

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
}
