import { MailboxClient__factory } from '@hyperlane-xyz/core';
import { buildArtifact as coreBuildArtifact } from '@hyperlane-xyz/core/buildArtifact.js';
import { ContractVerifier, ExplorerLicenseType } from '@hyperlane-xyz/sdk';
import {
  Address,
  Domain,
  ProtocolType,
  assert,
  rootLogger,
} from '@hyperlane-xyz/utils';

import {
  HyperlaneModule,
  HyperlaneModuleParams,
} from '../core/AbstractHyperlaneModule.js';
import { EvmIsmModule } from '../ism/EvmIsmModule.js';
import { DerivedIsmConfig } from '../ism/EvmIsmReader.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { AnnotatedEV5Transaction } from '../providers/ProviderType.js';
import { ChainNameOrId } from '../types.js';

import { EvmERC20WarpRouteReader } from './EvmERC20WarpRouteReader.js';
import { HypERC20Deployer } from './deploy.js';
import { TokenRouterConfig, TokenRouterConfigSchema } from './schemas.js';

export class EvmERC20WarpModule extends HyperlaneModule<
  ProtocolType.Ethereum,
  TokenRouterConfig,
  {
    deployedTokenRoute: Address;
  }
> {
  protected logger = rootLogger.child({
    module: 'EvmERC20WarpModule',
  });
  reader: EvmERC20WarpRouteReader;
  // We use domainId here because MultiProvider.getDomainId() will always
  // return a number, and EVM the domainId and chainId are the same.
  public readonly domainId: Domain;

  constructor(
    protected readonly multiProvider: MultiProvider,
    args: HyperlaneModuleParams<
      TokenRouterConfig,
      {
        deployedTokenRoute: Address;
      }
    >,
    protected readonly contractVerifier?: ContractVerifier,
  ) {
    super(args);
    this.reader = new EvmERC20WarpRouteReader(multiProvider, args.chain);
    this.domainId = multiProvider.getDomainId(args.chain);
    this.contractVerifier ??= new ContractVerifier(
      multiProvider,
      {},
      coreBuildArtifact,
      ExplorerLicenseType.MIT,
    );
  }

  /**
   * Retrieves the token router configuration for the specified address.
   *
   * @param address - The address to derive the token router configuration from.
   * @returns A promise that resolves to the token router configuration.
   */
  public async read(): Promise<TokenRouterConfig> {
    return this.reader.deriveWarpRouteConfig(
      this.args.addresses.deployedTokenRoute,
    );
  }

  /**
   * Updates the Warp Route contract with the provided configuration.
   *
   * @param expectedConfig - The configuration for the token router to be updated.
   * @returns An array of Ethereum transactions that were executed to update the contract, or an error if the update failed.
   */
  public async update(
    expectedConfig: TokenRouterConfig,
  ): Promise<AnnotatedEV5Transaction[]> {
    TokenRouterConfigSchema.parse(expectedConfig);
    const actualConfig = await this.read();

    return this.updateIsm(actualConfig, expectedConfig);
  }

  /**
   * Updates an existing Warp route ISM with a given config.
   *
   * @param actualConfig - The on-chain router configuration, including the ISM configuration, and address.
   * @param expectedConfig - The expected token router configuration, including the ISM configuration.
   * @returns Ethereum transaction that need to be executed to update the ISM configuration.
   */
  async updateIsm(
    actualConfig: TokenRouterConfig,
    expectedConfig: TokenRouterConfig,
  ): Promise<AnnotatedEV5Transaction[]> {
    const updateTransactions: AnnotatedEV5Transaction[] = [];
    const actualDeployedIsm = (
      actualConfig.interchainSecurityModule as DerivedIsmConfig
    ).address;

    // Try to update (may also deploy) Ism with the expected config
    const {
      deployedIsm: expectedDeployedIsm,
      updateTransactions: ismUpdateTransactions,
    } = await this.deployOrUpdateIsm(actualConfig, expectedConfig);

    // If an ISM is updated in-place, push the update txs
    updateTransactions.push(...ismUpdateTransactions);

    // If a new ISM is deployed, push the setInterchainSecurityModule tx
    if (actualDeployedIsm !== expectedDeployedIsm) {
      const contractToUpdate = MailboxClient__factory.connect(
        this.args.addresses.deployedTokenRoute,
        this.multiProvider.getProvider(this.args.chain),
      );
      updateTransactions.push({
        annotation: `Setting ISM for Warp Route to ${expectedDeployedIsm}`,
        chainId: this.domainId,
        to: contractToUpdate.address,
        data: contractToUpdate.interface.encodeFunctionData(
          'setInterchainSecurityModule',
          [expectedDeployedIsm],
        ),
      });
    }

    return updateTransactions;
  }

  /**
   * Updates or deploys the ISM using the provided configuration.
   *
   * @returns Object with deployedIsm address, and update Transactions
   */
  public async deployOrUpdateIsm(
    actualConfig: TokenRouterConfig,
    expectedConfig: TokenRouterConfig,
  ): Promise<{
    deployedIsm: Address;
    updateTransactions: AnnotatedEV5Transaction[];
  }> {
    assert(
      expectedConfig.interchainSecurityModule,
      'Ism not derived correctly',
    );
    assert(
      expectedConfig.ismFactoryAddresses,
      'Ism Factories addresses not provided',
    );

    const ismModule = new EvmIsmModule(
      this.multiProvider,
      {
        chain: this.args.chain,
        config: expectedConfig.interchainSecurityModule,
        addresses: {
          ...expectedConfig.ismFactoryAddresses,
          mailbox: expectedConfig.mailbox,
          deployedIsm: (
            actualConfig.interchainSecurityModule as DerivedIsmConfig
          ).address,
        },
      },
      this.contractVerifier,
    );
    this.logger.info(
      `Comparing target ISM config with ${this.args.chain} chain`,
    );
    const updateTransactions = await ismModule.update(
      expectedConfig.interchainSecurityModule,
    );
    const { deployedIsm } = ismModule.serialize();

    return { deployedIsm, updateTransactions };
  }

  /**
   * Deploys the Warp Route.
   *
   * @param chain - The chain to deploy the module on.
   * @param config - The configuration for the token router.
   * @param multiProvider - The multi-provider instance to use.
   * @returns A new instance of the EvmERC20WarpHyperlaneModule.
   */
  public static async create(params: {
    chain: ChainNameOrId;
    config: TokenRouterConfig;
    multiProvider: MultiProvider;
    contractVerifier?: ContractVerifier;
  }): Promise<EvmERC20WarpModule> {
    const { chain, config, multiProvider, contractVerifier } = params;
    const chainName = multiProvider.getChainName(chain);
    const deployer = new HypERC20Deployer(multiProvider);
    const deployedContracts = await deployer.deployContracts(chainName, config);

    return new EvmERC20WarpModule(
      multiProvider,
      {
        addresses: {
          deployedTokenRoute: deployedContracts[config.type].address,
        },
        chain,
        config,
      },
      contractVerifier,
    );
  }
}
