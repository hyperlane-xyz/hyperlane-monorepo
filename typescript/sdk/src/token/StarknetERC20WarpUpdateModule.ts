import { Account, BigNumberish, Uint256, eth, uint256 } from 'starknet';
import { zeroAddress } from 'viem';

import {
  Address,
  ChainId,
  Domain,
  ProtocolType,
  addressToBytes32,
  assert,
  deepEquals,
  difference,
  eqAddress,
  objMap,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { transferOwnershipTransactionsStarknet } from '../contracts/contracts.js';
import { HyperlaneAddresses } from '../contracts/types.js';
import { HyperlaneModuleParams } from '../core/AbstractHyperlaneModule.js';
import { ProxyFactoryFactories } from '../deploy/contracts.js';
import { StarknetHookModule } from '../hook/StarknetHookModule.js';
import { StarknetIsmModule } from '../ism/StarknetIsmModule.js';
import { MultiProtocolProvider } from '../providers/MultiProtocolProvider.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { AnnotatedStarknetTransaction } from '../providers/ProviderType.js';
import { RemoteRouters } from '../router/types.js';
import { ChainMap, ChainName, ChainNameOrId } from '../types.js';
import {
  getStarknetHypERC20CollateralContract,
  getStarknetHypERC20Contract,
  getStarknetMailboxClientContract,
} from '../utils/starknet.js';

import { StarknetERC20WarpRouteReader } from './StarknetERC20WarpRouteReader.js';
import {
  DerivedTokenRouterConfig,
  HypTokenRouterConfig,
  HypTokenRouterConfigSchema,
  WarpRouteDeployConfigMailboxRequired,
  derivedHookAddress,
  derivedIsmAddress,
} from './types.js';

type WarpRouteAddresses = HyperlaneAddresses<ProxyFactoryFactories> & {
  deployedTokenRoute: Address;
};
export class StarknetERC20WarpUpdateModule {
  protected logger = rootLogger.child({
    module: 'StarknetERC20WarpUpdateModule',
  });
  reader: StarknetERC20WarpRouteReader;

  public readonly chainName: ChainName;
  public readonly chainId: ChainId;
  public readonly domainId: Domain;
  protected readonly multiProvider: MultiProvider;

  public readonly args:
    | HyperlaneModuleParams<HypTokenRouterConfig, WarpRouteAddresses>
    | undefined;

  constructor(
    protected readonly account: Account,
    protected readonly multiProtocolProvider: MultiProtocolProvider,
    protected readonly config: WarpRouteDeployConfigMailboxRequired,
    protected readonly chain: ChainNameOrId,
    args?: HyperlaneModuleParams<HypTokenRouterConfig, WarpRouteAddresses>,
  ) {
    this.multiProvider = multiProtocolProvider.toMultiProvider();

    this.reader = new StarknetERC20WarpRouteReader(
      this.multiProtocolProvider,
      this.chain,
    );
    this.chainName = this.multiProvider.getChainName(this.chain);
    this.chainId = this.multiProvider.getChainId(this.chain);
    this.domainId = this.multiProvider.getDomainId(this.chain);
    this.chainId = this.multiProvider.getChainId(this.chain);
    this.args = args ?? undefined;
  }

  /**
   * Enrolls remote routers for all Starknet chains using the deployed token addresses
   * @param routerAddresses Map of chain name to token/router address
   */
  public async enrollRemoteRouters(
    routerAddresses: ChainMap<string>,
  ): Promise<void> {
    for (const [chain, tokenAddress] of Object.entries(routerAddresses)) {
      const isStarknetChain =
        this.multiProvider.getChainMetadata(chain).protocol !==
        ProtocolType.Starknet;
      if (isStarknetChain) {
        continue;
      }

      const account = this.account;

      // HypERC20 inherits RouterComponent
      const routerContract = getStarknetHypERC20Contract(tokenAddress, account);

      // Prepare arrays for batch enrollment
      const domains: number[] = [];
      const routers: Uint256[] = [];

      // Collect all remote chains' data
      Object.entries(routerAddresses).forEach(
        ([remoteChain, remoteAddress]) => {
          if (remoteChain === chain) return; // Skip self-enrollment

          const remoteDomain = this.multiProvider.getDomainId(remoteChain);
          const remoteProtocol =
            this.multiProvider.getChainMetadata(remoteChain).protocol;

          // Only validate and parse ETH address for Ethereum chains
          const remoteRouter = uint256.bnToUint256(
            remoteProtocol === ProtocolType.Ethereum
              ? eth.validateAndParseEthAddress(remoteAddress)
              : remoteAddress,
          );

          domains.push(remoteDomain);
          routers.push(remoteRouter);
        },
      );

      this.logger.info(
        `Batch enrolling ${domains.length} remote routers on ${chain}`,
      );

      const tx = await routerContract.invoke('enroll_remote_routers', [
        domains,
        routers,
      ]);

      const receipt = await account.waitForTransaction(tx.transaction_hash);

      receipt.match({
        success: (tx) => {
          this.logger.info(
            `Successfully enrolled all remote routers on ${chain}. Transaction: ${tx.transaction_hash}`,
          );
        },
        _: () => {
          this.logger.error(
            `Failed to enroll all remote routers on ${chain}. Transaction: ${tx?.transaction_hash}`,
          );
        },
      });
    }
  }

  /**
   * Retrieves the token router configuration for the specified address.
   *
   * @param address - The address to derive the token router configuration from.
   * @returns A promise that resolves to the token router configuration.
   */
  async read(): Promise<DerivedTokenRouterConfig> {
    assert(this.args, 'args is undefined');
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
  async update(
    expectedConfig: HypTokenRouterConfig,
  ): Promise<AnnotatedStarknetTransaction[]> {
    HypTokenRouterConfigSchema.parse(expectedConfig);
    const actualConfig = await this.read();

    const transactions = [];

    /**
     * @remark
     * The order of operations matter
     * 1. createOwnershipUpdateTxs() must always be LAST because no updates possible after ownership transferred
     * 2. createRemoteRoutersUpdateTxs() must always be BEFORE createSetDestinationGasUpdateTxs() because gas enumeration depends on domains
     */
    transactions.push(
      // ...(await this.createIsmUpdateTxs(actualConfig, expectedConfig)),
      // ...(await this.createHookUpdateTxs(actualConfig, expectedConfig)),
      ...this.createEnrollRemoteRoutersUpdateTxs(actualConfig, expectedConfig),
      ...this.createUnenrollRemoteRoutersUpdateTxs(
        actualConfig,
        expectedConfig,
      ),
      // ...this.createSetDestinationGasUpdateTxs(actualConfig, expectedConfig),
      ...this.createOwnershipUpdateTxs(actualConfig, expectedConfig),
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
  createEnrollRemoteRoutersUpdateTxs(
    actualConfig: DerivedTokenRouterConfig,
    expectedConfig: HypTokenRouterConfig,
  ): AnnotatedStarknetTransaction[] {
    assert(this.args, 'args is undefined');

    const updateTransactions: AnnotatedStarknetTransaction[] = [];
    if (!expectedConfig.remoteRouters) {
      return [];
    }

    assert(actualConfig.remoteRouters, 'actualRemoteRouters is undefined');
    assert(expectedConfig.remoteRouters, 'actualRemoteRouters is undefined');

    const { remoteRouters: actualRemoteRouters } = actualConfig;
    const { remoteRouters: expectedRemoteRouters } = expectedConfig;

    const routesToEnroll = Object.entries(expectedRemoteRouters)
      .map(([domain, rawRouter]): [string, RemoteRouters[string]] => [
        domain,
        { address: addressToBytes32(rawRouter.address) },
      ])
      .filter(([domain, expectedRouter]) => {
        const actualRouter = actualRemoteRouters[domain];
        // Enroll if router doesn't exist for domain or has different address
        return !actualRouter || actualRouter.address !== expectedRouter.address;
      })
      .map(([domain]) => domain);

    if (routesToEnroll.length === 0) {
      return updateTransactions;
    }

    const routerContract = getStarknetHypERC20Contract(
      this.args.addresses.deployedTokenRoute,
      this.account,
    );

    const tx = routerContract.populateTransaction.enroll_remote_routers(
      routesToEnroll.map((k) => Number(k)),
      routesToEnroll.map((a) =>
        addressToBytes32(expectedRemoteRouters[a].address),
      ),
    );

    updateTransactions.push({
      annotation: `Enrolling Router ${this.args.addresses.deployedTokenRoute} on ${this.args.chain}`,
      to: routerContract.address,
      ...tx,
      chainId: this.chainId,
    });

    return updateTransactions;
  }

  createUnenrollRemoteRoutersUpdateTxs(
    actualConfig: DerivedTokenRouterConfig,
    expectedConfig: HypTokenRouterConfig,
  ): AnnotatedStarknetTransaction[] {
    const updateTransactions: AnnotatedStarknetTransaction[] = [];
    assert(this.args, 'args is undefined');
    if (!expectedConfig.remoteRouters) {
      return [];
    }

    assert(actualConfig.remoteRouters, 'actualRemoteRouters is undefined');
    assert(expectedConfig.remoteRouters, 'actualRemoteRouters is undefined');

    const { remoteRouters: actualRemoteRouters } = actualConfig;
    const { remoteRouters: expectedRemoteRouters } = expectedConfig;

    const routesToUnenroll = Array.from(
      difference(
        new Set(Object.keys(actualRemoteRouters)),
        new Set(Object.keys(expectedRemoteRouters)),
      ),
    );

    if (routesToUnenroll.length === 0) {
      return updateTransactions;
    }

    const routerContract = getStarknetHypERC20Contract(
      this.args.addresses.deployedTokenRoute,
      this.account,
    );

    const tx = routerContract.populateTransaction.unenroll_remote_routers(
      routesToUnenroll.map((k) => Number(k)),
    );

    updateTransactions.push({
      annotation: `Unenrolling Router ${this.args.addresses.deployedTokenRoute} on ${this.args.chain}`,
      ...tx,
    });

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
    actualConfig: DerivedTokenRouterConfig,
    expectedConfig: HypTokenRouterConfig,
  ): AnnotatedStarknetTransaction[] {
    assert(this.args, 'args is undefined');

    const updateTransactions: AnnotatedStarknetTransaction[] = [];
    if (!expectedConfig.destinationGas) {
      return [];
    }

    assert(actualConfig.destinationGas, 'actualDestinationGas is undefined');
    assert(expectedConfig.destinationGas, 'actualDestinationGas is undefined');

    const { destinationGas: actualDestinationGas } = actualConfig;
    const { destinationGas: expectedDestinationGas } = expectedConfig;

    if (!deepEquals(actualDestinationGas, expectedDestinationGas)) {
      const routerContract = getStarknetHypERC20CollateralContract(
        this.args.addresses.deployedTokenRoute,
        this.account,
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

      const tx =
        routerContract.populateTransaction.set_destination_gas(
          gasRouterConfigs,
        );
      updateTransactions.push({
        annotation: `Setting destination gas for ${this.args.addresses.deployedTokenRoute} on ${this.args.chain}`,
        ...tx,
        chainId: this.chainId,
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
    actualConfig: DerivedTokenRouterConfig,
    expectedConfig: HypTokenRouterConfig,
  ): Promise<AnnotatedStarknetTransaction[]> {
    assert(this.args, 'args is undefined');
    const updateTransactions: AnnotatedStarknetTransaction[] = [];
    if (
      !expectedConfig.interchainSecurityModule ||
      expectedConfig.interchainSecurityModule === zeroAddress
    ) {
      return [];
    }

    const actualDeployedIsm = derivedIsmAddress(actualConfig);

    const {
      deployedIsm: expectedDeployedIsm,
      updateTransactions: ismUpdateTransactions,
    } = await this.deployOrUpdateIsm(actualConfig, expectedConfig);

    updateTransactions.push(...ismUpdateTransactions);

    if (actualDeployedIsm !== expectedDeployedIsm) {
      const contractToUpdate = getStarknetMailboxClientContract(
        this.args.addresses.deployedTokenRoute,
        this.account,
      );

      const tx =
        contractToUpdate.populateTransaction.set_interchain_security_module(
          expectedDeployedIsm,
        );

      updateTransactions.push({
        annotation: `Setting ISM for Warp Route to ${expectedDeployedIsm}`,
        ...tx,
        chainId: this.chainId,
      });
    }

    return updateTransactions;
  }

  async createHookUpdateTxs(
    actualConfig: DerivedTokenRouterConfig,
    expectedConfig: HypTokenRouterConfig,
  ): Promise<AnnotatedStarknetTransaction[]> {
    assert(this.args, 'args is undefined');
    const updateTransactions: AnnotatedStarknetTransaction[] = [];

    if (!expectedConfig.hook || expectedConfig.hook === zeroAddress) {
      return [];
    }

    const actualDeployedHook = derivedHookAddress(actualConfig);

    const {
      deployedHook: expectedDeployedHook,
      updateTransactions: hookUpdateTransactions,
    } = await this.deployOrUpdateHook(actualConfig, expectedConfig);

    // If a Hook is updated in-place, push the update txs
    updateTransactions.push(...hookUpdateTransactions);

    // If a new Hook is deployed, push the setHook tx
    if (!eqAddress(actualDeployedHook, expectedDeployedHook)) {
      const contractToUpdate = getStarknetMailboxClientContract(
        this.args.addresses.deployedTokenRoute,
        this.account,
      );
      const tx =
        contractToUpdate.populateTransaction.set_hook(expectedDeployedHook);
      updateTransactions.push({
        annotation: `Setting Hook for Warp Route to ${expectedDeployedHook}`,
        ...tx,
        chainId: this.chainId,
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
    actualConfig: DerivedTokenRouterConfig,
    expectedConfig: HypTokenRouterConfig,
  ): AnnotatedStarknetTransaction[] {
    assert(this.args, 'args is undefined');
    return transferOwnershipTransactionsStarknet(
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
  async deployOrUpdateIsm(
    actualConfig: DerivedTokenRouterConfig,
    expectedConfig: HypTokenRouterConfig,
  ): Promise<{
    deployedIsm: Address;
    updateTransactions: AnnotatedStarknetTransaction[];
  }> {
    assert(this.args, 'args is undefined');
    assert(expectedConfig.interchainSecurityModule, 'Ism derived incorrectly');
    const ismModule = new StarknetIsmModule(
      this.multiProtocolProvider,
      {
        chain: this.args.chain,
        config: expectedConfig.interchainSecurityModule,
        addresses: {
          ...this.args.addresses,
          mailbox: expectedConfig.mailbox,
          deployedIsm: derivedIsmAddress(actualConfig),
        },
      },
      this.account,
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
   * Updates or deploys the hook using the provided configuration.
   *
   * @returns Object with deployedHook address, and update Transactions
   */
  async deployOrUpdateHook(
    actualConfig: DerivedTokenRouterConfig,
    expectedConfig: HypTokenRouterConfig,
  ): Promise<{
    deployedHook: Address;
    updateTransactions: AnnotatedStarknetTransaction[];
  }> {
    assert(expectedConfig.hook, 'No hook config');
    if (!actualConfig.hook || actualConfig.hook === zeroAddress) {
      return this.deployNewHook(expectedConfig);
    }

    return this.updateExistingHook(expectedConfig, actualConfig);
  }

  async deployNewHook(expectedConfig: HypTokenRouterConfig): Promise<{
    deployedHook: Address;
    updateTransactions: AnnotatedStarknetTransaction[];
  }> {
    assert(this.args, 'args is undefined');
    this.logger.info(
      `No hook deployed for warp route, deploying new hook on ${this.args.chain} chain`,
    );

    assert(expectedConfig.hook, 'Hook is undefined');
    assert(
      expectedConfig.proxyAdmin?.address,
      'ProxyAdmin address is undefined',
    );

    const hookModule = await StarknetHookModule.create({
      chain: this.args.chain,
      config: expectedConfig.hook,
      mailboxAddress: expectedConfig.mailbox,
      signer: this.account,
      multiProtocolProvider: this.multiProtocolProvider,
    });
    const { deployedHook } = hookModule.serialize();
    return { deployedHook, updateTransactions: [] };
  }

  async updateExistingHook(
    expectedConfig: HypTokenRouterConfig,
    actualConfig: DerivedTokenRouterConfig,
  ): Promise<{
    deployedHook: Address;
    updateTransactions: AnnotatedStarknetTransaction[];
  }> {
    assert(this.args, 'args is undefined');
    assert(actualConfig.proxyAdmin?.address, 'ProxyAdmin address is undefined');
    assert(actualConfig.hook, 'Hook is undefined');

    const hookModule = await StarknetHookModule.create({
      chain: this.args.chain,
      config: actualConfig.hook,
      mailboxAddress: actualConfig.mailbox,
      signer: this.account,
      multiProtocolProvider: this.multiProtocolProvider,
    });

    this.logger.info(
      `Comparing target Hook config with ${this.args.chain} chain`,
    );
    const updateTransactions = await hookModule.update(expectedConfig.hook!);
    const { deployedHook } = hookModule.serialize();

    return { deployedHook, updateTransactions };
  }
}
