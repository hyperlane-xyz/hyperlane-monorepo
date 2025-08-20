import { constants } from 'ethers';

import {
  Address,
  Annotated,
  ProtocolType,
  rootLogger,
} from '@hyperlane-xyz/utils';

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
    config: TokenFeeConfigInput;
    contractVerifier?: ContractVerifier;
  }): Promise<EvmTokenFeeModule> {
    const chainName = multiProvider.getChainName(chain);
    const deployer = new EvmTokenFeeDeployer(multiProvider, chainName, {
      contractVerifier: contractVerifier,
    });

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

    const intermediaryConfig: Partial<TokenFeeConfig> = { ...config };
    if (config.type === TokenFeeType.LinearFee) {
      const { maxFee, halfAmount } = await module.reader.convertFromBps(
        config.bps,
        config.token,
      );
      intermediaryConfig.maxFee = maxFee;
      intermediaryConfig.halfAmount = halfAmount;
    }
    const finalizedConfig = TokenFeeConfigSchema.parse(intermediaryConfig);

    const contracts = await deployer.deploy({ [chain]: finalizedConfig });
    module.args.addresses.deployedFee = contracts[chain][config.type].address;

    return module;
  }

  // Public accessor for the deployed fee contract address
  getDeployedFeeAddress(): Address {
    return this.args.addresses.deployedFee;
  }

  async read(): Promise<DerivedTokenFeeConfig> {
    return this.reader.deriveTokenFeeConfig(this.args.addresses.deployedFee);
  }

  async update(
    _config: TokenFeeConfigInput,
  ): Promise<
    Annotated<ProtocolTypedTransaction<ProtocolType.Ethereum>['transaction']>[]
  > {
    throw new Error('Not implemented');
  }
}
