import { Domain, ProtocolType, rootLogger } from '@hyperlane-xyz/utils';

import { serializeContracts } from '../contracts/contracts.js';
import { HyperlaneAddresses } from '../contracts/types.js';
import { proxyAdminOwnershipUpdateTxs } from '../deploy/proxy.js';
import { ContractVerifier } from '../deploy/verify/ContractVerifier.js';
import { EvmIcaRouterReader } from '../ica/EvmIcaReader.js';
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
  protected icaRouterReader: EvmIcaRouterReader;
  public readonly domainId: Domain;

  protected constructor(
    protected readonly multiProvider: MultiProvider,
    args: HyperlaneModuleParams<
      InterchainAccountConfig,
      HyperlaneAddresses<InterchainAccountFactories>
    >,
  ) {
    super(args);
    this.icaRouterReader = new EvmIcaRouterReader(
      multiProvider.getProvider(this.args.chain),
    );
    this.domainId = multiProvider.getDomainId(args.chain);
  }

  public async read(): Promise<InterchainAccountConfig> {
    throw new Error('Method not implemented.');
  }

  public async update(
    expectedConfig: InterchainAccountConfig,
  ): Promise<AnnotatedEV5Transaction[]> {
    const actualConfig = await this.read();

    const transactions: AnnotatedEV5Transaction[] = [
      ...proxyAdminOwnershipUpdateTxs(
        actualConfig,
        expectedConfig,
        this.domainId,
      ),
    ];

    return transactions;
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
