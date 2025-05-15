import {
  Domain,
  EvmChainId,
  ProtocolType,
  deepEquals,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { serializeContracts } from '../contracts/contracts.js';
import { HyperlaneAddresses } from '../contracts/types.js';
import { ContractVerifier } from '../deploy/verify/ContractVerifier.js';
import { EvmIcaRouterReader } from '../ica/EvmIcaReader.js';
import { DerivedIcaRouterConfig, IcaRouterConfig } from '../ica/types.js';
import { InterchainAccountDeployer } from '../middleware/account/InterchainAccountDeployer.js';
import { InterchainAccountFactories } from '../middleware/account/contracts.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { AnnotatedEV5Transaction } from '../providers/ProviderType.js';
import { ChainNameOrId } from '../types.js';

import {
  HyperlaneModule,
  HyperlaneModuleParams,
} from './AbstractHyperlaneModule.js';

// just an alias
type InterchainAccountConfig = IcaRouterConfig;

export class EvmIcaModule extends HyperlaneModule<
  ProtocolType.Ethereum,
  InterchainAccountConfig,
  HyperlaneAddresses<InterchainAccountFactories>
> {
  protected logger = rootLogger.child({ module: 'EvmIcaModule' });
  protected icaRouterReader: EvmIcaRouterReader;
  public readonly domainId: Domain;
  public readonly chainId: EvmChainId;

  constructor(
    protected readonly multiProvider: MultiProvider,
    args: HyperlaneModuleParams<
      InterchainAccountConfig,
      HyperlaneAddresses<InterchainAccountFactories>
    >,
  ) {
    super(args);
    this.icaRouterReader = new EvmIcaRouterReader(
      multiProvider,
      this.args.chain,
    );
    this.domainId = multiProvider.getDomainId(args.chain);
    this.chainId = multiProvider.getEvmChainId(args.chain);
  }

  public async read(): Promise<DerivedIcaRouterConfig> {
    return this.icaRouterReader.deriveConfig(
      this.args.addresses.interchainAccountRouter,
    );
  }

  public async update(
    expectedConfig: InterchainAccountConfig,
  ): Promise<AnnotatedEV5Transaction[]> {
    const actualConfig = await this.read();

    if (deepEquals(actualConfig, expectedConfig)) {
      return [];
    }

    // TODO: implement offchain lookup URL updates and router enrollments
    throw new Error('Not implemented');
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
