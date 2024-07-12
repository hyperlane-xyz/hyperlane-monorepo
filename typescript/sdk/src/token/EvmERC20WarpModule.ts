import {
  MailboxClient__factory,
  TokenRouter__factory,
} from '@hyperlane-xyz/core';
import {
  Address,
  Domain,
  ProtocolType,
  addressToBytes32,
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
import { RemoteRouter } from '../router/types.js';
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
  ) {
    super(args);
    this.reader = new EvmERC20WarpRouteReader(multiProvider, args.chain);
    this.domainId = multiProvider.getDomainId(args.chain);
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

    const transactions = [];

    transactions.push(
      ...(await this.updateIsm(actualConfig, expectedConfig)),
      ...(await this.updateRemoteRouters(
        actualConfig.remoteRouters!,
        expectedConfig.remoteRouters!,
      )),
    );

    return transactions;
  }

  /**
   * Enrolls the remote routers for the Warp Route contract.
   *
   * @param actualRemoteRouters - The current remote routers configured on the contract.
   * @param expectedRemoteRouters - The new remote routers to be configured on the contract.
   * @returns Ethereum transaction that need to be executed to enroll the routers
   */
  async updateRemoteRouters(
    actualRemoteRouters: RemoteRouter[],
    expectedRemoteRouters: RemoteRouter[],
  ): Promise<AnnotatedEV5Transaction[]> {
    let updateTransactions: AnnotatedEV5Transaction[] = [];
    if (
      expectedRemoteRouters.length > 0 &&
      expectedRemoteRouters.length > actualRemoteRouters.length
    ) {
      const contractToUpdate = TokenRouter__factory.connect(
        this.args.addresses.deployedTokenRoute,
        this.multiProvider.getProvider(this.domainId),
      );

      const enrollRemoteRoutersParameters = expectedRemoteRouters.reduce<
        [
          number[], // domain
          string[], // router
        ]
      >(
        (results, remoteRouter) => {
          results[0].push(remoteRouter.domain);
          results[1].push(addressToBytes32(remoteRouter.router));
          return results;
        },
        [[], []],
      );

      updateTransactions.push({
        annotation: `Enrolling Router ${this.args.addresses.deployedTokenRoute}}`,
        chainId: this.domainId,
        to: contractToUpdate.address,
        data: contractToUpdate.interface.encodeFunctionData(
          'enrollRemoteRouters',
          enrollRemoteRoutersParameters,
        ),
      });
    }
    return updateTransactions;
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
        this.multiProvider.getProvider(this.domainId),
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

    const ismModule = new EvmIsmModule(this.multiProvider, {
      chain: this.args.chain,
      config: expectedConfig.interchainSecurityModule,
      addresses: {
        ...expectedConfig.ismFactoryAddresses,
        mailbox: expectedConfig.mailbox,
        deployedIsm: (actualConfig.interchainSecurityModule as DerivedIsmConfig)
          .address,
      },
    });
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
  }): Promise<EvmERC20WarpModule> {
    const { chain, config, multiProvider } = params;
    const chainName = multiProvider.getChainName(chain);
    const deployer = new HypERC20Deployer(multiProvider);
    const deployedContracts = await deployer.deployContracts(chainName, config);

    const warpModule = new EvmERC20WarpModule(multiProvider, {
      addresses: {
        deployedTokenRoute: deployedContracts[config.type].address,
      },
      chain,
      config,
    });

    // Enroll Remote Routers
    if (config.remoteRouters?.length) {
      const actualRemoteRouters = (await warpModule.read()).remoteRouters!;
      const expectedRemoteRouters = config.remoteRouters;
      const enrollRemoteTx = await warpModule.updateRemoteRouters(
        actualRemoteRouters,
        expectedRemoteRouters,
      );

      await multiProvider.sendTransaction(chain, enrollRemoteTx[0]); // updateRemoteRouters is always a single tx
    }

    return warpModule;
  }
}
