import { ProtocolType, rootLogger } from '@hyperlane-xyz/utils';

import { serializeContracts } from '../contracts/contracts.js';
import { HyperlaneAddresses } from '../contracts/types.js';
import { ContractVerifier } from '../deploy/verify/ContractVerifier.js';
import { InterchainAccountDeployer } from '../middleware/account/InterchainAccountDeployer.js';
import { InterchainAccountFactories } from '../middleware/account/contracts.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { AnnotatedEV5Transaction } from '../providers/ProviderType.js';
import { ProxiedRouterConfig } from '../router/types.js';
import { ChainNameOrId } from '../types.js';

import {
  HyperlaneModule,
  HyperlaneModuleParams,
} from './AbstractHyperlaneModule.js';

export type InterchainAccountConfig = ProxiedRouterConfig;

export class EvmIcaModule extends HyperlaneModule<
  ProtocolType.Ethereum,
  InterchainAccountConfig,
  HyperlaneAddresses<InterchainAccountFactories>
> {
  protected logger = rootLogger.child({ module: 'EvmIcaModule' });

  protected constructor(
    protected readonly multiProvider: MultiProvider,
    args: HyperlaneModuleParams<
      InterchainAccountConfig,
      HyperlaneAddresses<InterchainAccountFactories>
    >,
  ) {
    super(args);
  }

  public async read(): Promise<InterchainAccountConfig> {
    throw new Error('Method not implemented.');
  }

  public async update(
    _config: InterchainAccountConfig,
  ): Promise<AnnotatedEV5Transaction[]> {
    throw new Error('Method not implemented.');
  }

  /**
   * Creates a new EvmIcaModule instance by deploying an ICA with an ICA ISM.
   *
   * @param chain - The chain on which to deploy the ICA.
   * @param config - The configuration for the ICA.
   * @param multiProvider - The MultiProvider instance to use for deployment.
   * @returns {Promise<EvmIcaModule>} - A new EvmIcaModule instance.
   */
  public static async create({
    chain,
    config,
    multiProvider,
    contractVerifier,
  }: {
    chain: ChainNameOrId;
    config: InterchainAccountConfig;
    multiProvider: MultiProvider;
    contractVerifier?: ContractVerifier;
  }): Promise<EvmIcaModule> {
    const interchainAccountDeployer = new InterchainAccountDeployer(
      multiProvider,
      contractVerifier,
    );
    const deployedContracts = await interchainAccountDeployer.deployContracts(
      multiProvider.getChainName(chain),
      config,
    );

    return new EvmIcaModule(multiProvider, {
      addresses: serializeContracts(deployedContracts),
      chain,
      config,
    });
  }
}
