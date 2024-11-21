import { BigNumberish } from 'ethers';

import {
  GasRouter__factory,
  MailboxClient__factory,
  TokenRouter__factory,
} from '@hyperlane-xyz/core';
import { buildArtifact as coreBuildArtifact } from '@hyperlane-xyz/core/buildArtifact.js';
import {
  ContractVerifier,
  ExplorerLicenseType,
  HyperlaneAddresses,
} from '@hyperlane-xyz/sdk';
import {
  Address,
  Domain,
  EvmChainId,
  ProtocolType,
  addressToBytes32,
  assert,
  deepEquals,
  isObjEmpty,
  objMap,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { transferOwnershipTransactions } from '../contracts/contracts.js';
import {
  HyperlaneModule,
  HyperlaneModuleParams,
} from '../core/AbstractHyperlaneModule.js';
import { ProxyFactoryFactories } from '../deploy/contracts.js';
import { proxyAdminUpdateTxs } from '../deploy/proxy.js';
import { EvmIsmModule } from '../ism/EvmIsmModule.js';
import { DerivedIsmConfig } from '../ism/EvmIsmReader.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { AnnotatedEV5Transaction } from '../providers/ProviderType.js';
import { ChainName, ChainNameOrId } from '../types.js';
import { normalizeConfig } from '../utils/ism.js';

import { EvmERC20WarpRouteReader } from './EvmERC20WarpRouteReader.js';
import { HypERC20Deployer } from './deploy.js';
import { TokenRouterConfig, TokenRouterConfigSchema } from './schemas.js';

export class EvmERC20WarpModule extends HyperlaneModule<
  ProtocolType.Ethereum,
  TokenRouterConfig,
  HyperlaneAddresses<ProxyFactoryFactories> & {
    deployedTokenRoute: Address;
  }
> {
  protected logger = rootLogger.child({
    module: 'EvmERC20WarpModule',
  });
  reader: EvmERC20WarpRouteReader;
  public readonly chainName: ChainName;
  public readonly chainId: EvmChainId;
  public readonly domainId: Domain;

  constructor(
    protected readonly multiProvider: MultiProvider,
    args: HyperlaneModuleParams<
      TokenRouterConfig,
      HyperlaneAddresses<ProxyFactoryFactories> & {
        deployedTokenRoute: Address;
      }
    >,
    protected readonly contractVerifier?: ContractVerifier,
  ) {
    super(args);
    this.reader = new EvmERC20WarpRouteReader(multiProvider, args.chain);
    this.chainName = this.multiProvider.getChainName(args.chain);
    this.chainId = multiProvider.getEvmChainId(args.chain);
    this.domainId = multiProvider.getDomainId(args.chain);
    this.chainId = multiProvider.getEvmChainId(args.chain);
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

    const transactions = [];

    /**
     * @remark
     * The order of operations matter
     * 1. createOwnershipUpdateTxs() must always be LAST because no updates possible after ownership transferred
     * 2. createRemoteRoutersUpdateTxs() must always be BEFORE createSetDestinationGasUpdateTxs() because gas enumeration depends on domains
     */
    transactions.push(
      ...(await this.createIsmUpdateTxs(actualConfig, expectedConfig)),
      ...this.createRemoteRoutersUpdateTxs(actualConfig, expectedConfig),
      ...this.createSetDestinationGasUpdateTxs(actualConfig, expectedConfig),
      ...this.createOwnershipUpdateTxs(actualConfig, expectedConfig),
      ...proxyAdminUpdateTxs(
        this.chainId,
        this.args.addresses.deployedTokenRoute,
        actualConfig,
        expectedConfig,
      ),
    );

    return transactions;
  }

  /**
   * Create a transaction to update the remote routers for the Warp Route contract.
   *
   * @param actualConfig - The on-chain router configuration, including the remoteRouters array.
   * @param expectedConfig - The expected token router configuration.
   * @returns A array with a single Ethereum transaction that need to be executed to enroll the routers
   */
  createRemoteRoutersUpdateTxs(
    actualConfig: TokenRouterConfig,
    expectedConfig: TokenRouterConfig,
  ): AnnotatedEV5Transaction[] {
    const updateTransactions: AnnotatedEV5Transaction[] = [];
    if (!expectedConfig.remoteRouters) {
      return [];
    }

    // We normalize the addresses for comparison
    actualConfig.remoteRouters = normalizeConfig(actualConfig.remoteRouters);
    expectedConfig.remoteRouters = normalizeConfig(
      expectedConfig.remoteRouters,
    );
    assert(actualConfig.remoteRouters, 'actualRemoteRouters is undefined');
    assert(expectedConfig.remoteRouters, 'actualRemoteRouters is undefined');

    const { remoteRouters: actualRemoteRouters } = actualConfig;
    const { remoteRouters: expectedRemoteRouters } = expectedConfig;

    if (!deepEquals(actualRemoteRouters, expectedRemoteRouters)) {
      const contractToUpdate = TokenRouter__factory.connect(
        this.args.addresses.deployedTokenRoute,
        this.multiProvider.getProvider(this.domainId),
      );

      updateTransactions.push({
        chainId: this.chainId,
        annotation: `Enrolling Router ${this.args.addresses.deployedTokenRoute} on ${this.args.chain}`,
        to: contractToUpdate.address,
        data: contractToUpdate.interface.encodeFunctionData(
          'enrollRemoteRouters',
          [
            Object.keys(expectedRemoteRouters).map((k) => Number(k)),
            Object.values(expectedRemoteRouters).map((a) =>
              addressToBytes32(a),
            ),
          ],
        ),
      });
    }
    return updateTransactions;
  }

  /**
   * Create a transaction to update the remote routers for the Warp Route contract.
   *
   * @param actualConfig - The on-chain router configuration, including the remoteRouters array.
   * @param expectedConfig - The expected token router configuration.
   * @returns A array with a single Ethereum transaction that need to be executed to enroll the routers
   */
  createSetDestinationGasUpdateTxs(
    actualConfig: TokenRouterConfig,
    expectedConfig: TokenRouterConfig,
  ): AnnotatedEV5Transaction[] {
    const updateTransactions: AnnotatedEV5Transaction[] = [];
    if (!expectedConfig.destinationGas) {
      return [];
    }

    assert(actualConfig.destinationGas, 'actualDestinationGas is undefined');
    assert(expectedConfig.destinationGas, 'actualDestinationGas is undefined');

    const { destinationGas: actualDestinationGas } = actualConfig;
    const { destinationGas: expectedDestinationGas } = expectedConfig;

    if (!deepEquals(actualDestinationGas, expectedDestinationGas)) {
      const contractToUpdate = GasRouter__factory.connect(
        this.args.addresses.deployedTokenRoute,
        this.multiProvider.getProvider(this.domainId),
      );

      // Convert { 1: 2, 2: 3, ... } to [{ 1: 2 }, { 2: 3 }]
      const gasRouterConfigs: { domain: BigNumberish; gas: BigNumberish }[] =
        [];
      objMap(expectedDestinationGas, (domain: string, gas: string) => {
        gasRouterConfigs.push({
          domain,
          gas,
        });
      });

      updateTransactions.push({
        chainId: this.chainId,
        annotation: `Setting destination gas for ${this.args.addresses.deployedTokenRoute} on ${this.args.chain}`,
        to: contractToUpdate.address,
        data: contractToUpdate.interface.encodeFunctionData(
          'setDestinationGas((uint32,uint256)[])',
          [gasRouterConfigs],
        ),
      });
    }
    return updateTransactions;
  }

  /**
   * Create transactions to update an existing ISM config, or deploy a new ISM and return a tx to setInterchainSecurityModule
   *
   * @param actualConfig - The on-chain router configuration, including the ISM configuration, and address.
   * @param expectedConfig - The expected token router configuration, including the ISM configuration.
   * @returns Ethereum transaction that need to be executed to update the ISM configuration.
   */
  async createIsmUpdateTxs(
    actualConfig: TokenRouterConfig,
    expectedConfig: TokenRouterConfig,
  ): Promise<AnnotatedEV5Transaction[]> {
    const updateTransactions: AnnotatedEV5Transaction[] = [];
    if (!expectedConfig.interchainSecurityModule) {
      return [];
    }

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
        chainId: this.chainId,
        annotation: `Setting ISM for Warp Route to ${expectedDeployedIsm}`,
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
   * Transfer ownership of an existing Warp route with a given config.
   *
   * @param actualConfig - The on-chain router configuration.
   * @param expectedConfig - The expected token router configuration.
   * @returns Ethereum transaction that need to be executed to update the owner.
   */
  createOwnershipUpdateTxs(
    actualConfig: TokenRouterConfig,
    expectedConfig: TokenRouterConfig,
  ): AnnotatedEV5Transaction[] {
    return transferOwnershipTransactions(
      this.multiProvider.getEvmChainId(this.args.chain),
      this.args.addresses.deployedTokenRoute,
      actualConfig,
      expectedConfig,
      `${expectedConfig.type} Warp Route`,
    );
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

    const ismModule = new EvmIsmModule(
      this.multiProvider,
      {
        chain: this.args.chain,
        config: expectedConfig.interchainSecurityModule,
        addresses: {
          ...this.args.addresses,
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
    proxyFactoryFactories: HyperlaneAddresses<ProxyFactoryFactories>;
  }): Promise<EvmERC20WarpModule> {
    const {
      chain,
      config,
      multiProvider,
      contractVerifier,
      proxyFactoryFactories,
    } = params;
    const chainName = multiProvider.getChainName(chain);
    const deployer = new HypERC20Deployer(multiProvider);
    const deployedContracts = await deployer.deployContracts(chainName, config);

    const warpModule = new EvmERC20WarpModule(
      multiProvider,
      {
        addresses: {
          ...proxyFactoryFactories,
          deployedTokenRoute: deployedContracts[config.type].address,
        },
        chain,
        config,
      },
      contractVerifier,
    );

    if (config.remoteRouters && !isObjEmpty(config.remoteRouters)) {
      const enrollRemoteTxs = await warpModule.update(config); // @TODO Remove when EvmERC20WarpModule.create can be used
      const onlyTxIndex = 0;
      await multiProvider.sendTransaction(chain, enrollRemoteTxs[onlyTxIndex]);
    }

    return warpModule;
  }
}
