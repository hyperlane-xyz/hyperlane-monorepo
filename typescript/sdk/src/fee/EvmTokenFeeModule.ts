import { constants } from 'ethers';

import {
  Address,
  Annotated,
  ProtocolType,
  assert,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { HyperlaneContractsMap } from '../contracts/types.js';
import {
  HyperlaneModule,
  HyperlaneModuleParams,
} from '../core/AbstractHyperlaneModule.js';
import { ContractVerifier } from '../deploy/verify/ContractVerifier.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { ProtocolTypedTransaction } from '../providers/ProviderType.js';
import { ChainNameOrId } from '../types.js';

import { EvmTokenFeeDeployer } from './EvmTokenFeeDeployer.js';
import {
  DerivedTokenFeeConfig,
  EvmTokenFeeReader,
} from './EvmTokenFeeReader.js';
import { EvmTokenFeeFactories } from './contracts.js';
import {
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
  constructor(
    protected readonly multiProvider: MultiProvider,
    params: HyperlaneModuleParams<TokenFeeConfigInput, TokenFeeModuleAddresses>,
    protected readonly contractVerifier?: ContractVerifier,
  ) {
    super(params);
    const chainName = multiProvider.getChainName(params.chain);
    this.deployer = new EvmTokenFeeDeployer(multiProvider, chainName, {
      logger: this.logger,
      contractVerifier: contractVerifier,
    });
    this.reader = new EvmTokenFeeReader(multiProvider, chainName);
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

    const finalizedConfig = await EvmTokenFeeModule.processConfig({
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
  public static async processConfig(params: {
    config: TokenFeeConfigInput;
    multiProvider: MultiProvider;
    chainName: string;
  }): Promise<TokenFeeConfig> {
    const intermediaryConfig: Partial<TokenFeeConfig> = { ...params.config };
    if (params.config.type === TokenFeeType.LinearFee) {
      assert(
        params.config.token,
        'Token address is required to process config',
      );
      const reader = new EvmTokenFeeReader(
        params.multiProvider,
        params.chainName,
      );
      const { maxFee, halfAmount } = await reader.convertFromBps(
        params.config.bps,
        params.config.token,
      );
      intermediaryConfig.maxFee = maxFee;
      intermediaryConfig.halfAmount = halfAmount;
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

  // Public accessor for the deployed fee contract address
  getDeployedFeeAddress(): Address {
    return this.args.addresses.deployedFee;
  }

  async read(routingDestinations?: number[]): Promise<DerivedTokenFeeConfig> {
    return this.reader.deriveTokenFeeConfig(
      this.args.addresses.deployedFee,
      routingDestinations,
    );
  }

  async update(
    _config: TokenFeeConfigInput,
  ): Promise<
    Annotated<ProtocolTypedTransaction<ProtocolType.Ethereum>['transaction']>[]
  > {
    throw new Error('Not implemented');
  }
}
