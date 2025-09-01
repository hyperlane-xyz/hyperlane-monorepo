import { constants } from 'ethers';
import _ from 'lodash';

import { RoutingFee__factory } from '@hyperlane-xyz/core';
import {
  Address,
  ProtocolType,
  deepEquals,
  objMap,
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

    const finalizedConfig = await EvmTokenFeeModule.expandConfig({
      config,
      multiProvider,
      chainName,
    });

    const contracts = await module.deploy({
      multiProvider,
      chainName,
      contractVerifier,
      config: finalizedConfig,
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
      const { maxFee, halfAmount } = await reader.convertFromBps(
        config.bps,
        config.token,
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
    const routingDestinations = params?.routingDestinations ?? [];

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

    // if the type is a immutable type, then redeploy
    if (
      ImmutableTokenFeeType.includes(
        normalizedTargetConfig.type as (typeof ImmutableTokenFeeType)[number],
      )
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
    }

    // if the type is a mutable type, then update
    updateTransactions = [
      ...(await this.updateRoutingFee(
        _.merge(
          actualConfig,
          normalizedTargetConfig,
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
              deployedFee: constants.AddressZero,
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
        updateTransactions.push({
          annotation: 'Updating routing fee...',
          chainId: this.chainId,
          to: currentRoutingAddress,
          data: RoutingFee__factory.createInterface().encodeFunctionData(
            'setFeeContract(uint32,address)',
            [this.multiProvider.getDomainId(chainName), deployedSubFee],
          ),
        });
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
