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
import { TokenFeeConfig } from './types.js';

type TokenFeeModuleAddresses = {
  deployedFee: Address;
};
export class EvmTokenFeeModule extends HyperlaneModule<
  ProtocolType.Ethereum,
  TokenFeeConfig,
  TokenFeeModuleAddresses
> {
  protected readonly logger = rootLogger.child({ module: 'EvmTokenFeeModule' });
  protected readonly deployer: EvmTokenFeeDeployer;

  constructor(
    protected readonly multiProvider: MultiProvider,
    params: HyperlaneModuleParams<TokenFeeConfig, TokenFeeModuleAddresses>,
    protected readonly contractVerifier?: ContractVerifier,
  ) {
    super(params);
    const chainName = multiProvider.getChainName(params.chain);
    this.deployer = new EvmTokenFeeDeployer(multiProvider, chainName, {
      logger: this.logger,
      contractVerifier: contractVerifier,
    });
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
    const deployer = new EvmTokenFeeDeployer(multiProvider, chainName, {
      contractVerifier: contractVerifier,
    });
    const contracts = await deployer.deploy({ [chain]: config });
    const module = new EvmTokenFeeModule(
      multiProvider,
      {
        addresses: {
          deployedFee: contracts[chain][config.type].address,
        },
        chain,
        config,
      },
      contractVerifier,
    );
    return module;
  }

  async update(
    _config: TokenFeeConfig,
  ): Promise<
    Annotated<ProtocolTypedTransaction<ProtocolType.Ethereum>['transaction']>[]
  > {
    throw new Error('Not implemented');
  }

  async read(): Promise<TokenFeeConfig> {
    throw new Error('Not implemented');
  }
}
