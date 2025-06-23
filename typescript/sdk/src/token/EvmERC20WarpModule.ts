// import { expect } from 'chai';
import { compareVersions } from 'compare-versions';
import { BigNumberish } from 'ethers';
import { UINT_256_MAX } from 'starknet';
import { zeroAddress } from 'viem';

import {
  FungibleTokenRouter__factory,
  GasRouter__factory,
  IERC20__factory,
  MailboxClient__factory,
  MovableCollateralRouter__factory,
  ProxyAdmin__factory,
  TokenRouter__factory,
} from '@hyperlane-xyz/core';
import { buildArtifact as coreBuildArtifact } from '@hyperlane-xyz/core/buildArtifact.js';
import {
  Address,
  Domain,
  EvmChainId,
  ProtocolType,
  addressToBytes32,
  assert,
  deepEquals,
  difference,
  eqAddress,
  isObjEmpty,
  normalizeAddressEvm,
  objMap,
  promiseObjAll,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { CCIPContractCache } from '../ccip/utils.js';
import { transferOwnershipTransactions } from '../contracts/contracts.js';
import { HyperlaneAddresses } from '../contracts/types.js';
import {
  HyperlaneModule,
  HyperlaneModuleParams,
} from '../core/AbstractHyperlaneModule.js';
import { ProxyFactoryFactories } from '../deploy/contracts.js';
import {
  isInitialized,
  proxyAdmin,
  proxyAdminUpdateTxs,
} from '../deploy/proxy.js';
import { ContractVerifier } from '../deploy/verify/ContractVerifier.js';
import { ExplorerLicenseType } from '../deploy/verify/types.js';
import { EvmHookModule } from '../hook/EvmHookModule.js';
import { EvmIsmModule } from '../ism/EvmIsmModule.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { AnnotatedEV5Transaction } from '../providers/ProviderType.js';
import { RemoteRouters, resolveRouterMapConfig } from '../router/types.js';
import { ChainName, ChainNameOrId } from '../types.js';
import { extractIsmAndHookFactoryAddresses } from '../utils/ism.js';

import { EvmERC20WarpRouteReader } from './EvmERC20WarpRouteReader.js';
import { HypERC20Deployer } from './deploy.js';
import {
  DerivedTokenRouterConfig,
  HypTokenRouterConfig,
  HypTokenRouterConfigSchema,
  MovableTokenConfig,
  VERSION_ERROR_MESSAGE,
  contractVersionMatchesDependency,
  derivedHookAddress,
  derivedIsmAddress,
  isMovableCollateralTokenConfig,
} from './types.js';

type WarpRouteAddresses = HyperlaneAddresses<ProxyFactoryFactories> & {
  deployedTokenRoute: Address;
};

const getAllowedRebalancingBridgesByDomain = (
  allowedRebalancingBridgesByDomain: NonNullable<
    MovableTokenConfig['allowedRebalancingBridges']
  >,
): Record<string, Set<Address>> => {
  return objMap(
    allowedRebalancingBridgesByDomain,
    (_domainId, allowedRebalancingBridges) => {
      return new Set(
        allowedRebalancingBridges.map((bridgeConfig) =>
          normalizeAddressEvm(bridgeConfig.bridge),
        ),
      );
    },
  );
};
export class EvmERC20WarpModule extends HyperlaneModule<
  ProtocolType.Ethereum,
  HypTokenRouterConfig,
  WarpRouteAddresses
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
    args: HyperlaneModuleParams<HypTokenRouterConfig, WarpRouteAddresses>,
    protected readonly ccipContractCache?: CCIPContractCache,
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
  async read(): Promise<DerivedTokenRouterConfig> {
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
  ): Promise<AnnotatedEV5Transaction[]> {
    HypTokenRouterConfigSchema.parse(expectedConfig);
    const actualConfig = await this.read();
    const transactions = [];

    /**
     * @remark
     * The order of operations matter
     * 1. upgradeWarpRouteImplementationTx() must always be FIRST because subsequent updates may depend on the latest implementation
     * 2. createOwnershipUpdateTxs() must always be LAST because no updates possible after ownership transferred
     * 3. createRemoteRoutersUpdateTxs() must always be BEFORE createSetDestinationGasUpdateTxs() because gas enumeration depends on domains
     */
    transactions.push(
      ...(await this.upgradeWarpRouteImplementationTx(
        actualConfig,
        expectedConfig,
      )),
      ...(await this.createFeeRecipientUpdateTxs(actualConfig, expectedConfig)),
      ...(await this.createIsmUpdateTxs(actualConfig, expectedConfig)),
      ...(await this.createHookUpdateTxs(actualConfig, expectedConfig)),
      ...this.createEnrollRemoteRoutersUpdateTxs(actualConfig, expectedConfig),
      ...this.createUnenrollRemoteRoutersUpdateTxs(
        actualConfig,
        expectedConfig,
      ),
      ...this.createSetDestinationGasUpdateTxs(actualConfig, expectedConfig),
      ...this.createAddRebalancersUpdateTxs(actualConfig, expectedConfig),
      ...this.createRemoveRebalancersUpdateTxs(actualConfig, expectedConfig),
      ...(await this.createAddAllowedBridgesUpdateTxs(
        actualConfig,
        expectedConfig,
      )),
      ...this.createRemoveBridgesTxs(actualConfig, expectedConfig),
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
  createEnrollRemoteRoutersUpdateTxs(
    actualConfig: DerivedTokenRouterConfig,
    expectedConfig: HypTokenRouterConfig,
  ): AnnotatedEV5Transaction[] {
    const updateTransactions: AnnotatedEV5Transaction[] = [];
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
          routesToEnroll.map((k) => Number(k)),
          routesToEnroll.map((a) =>
            addressToBytes32(expectedRemoteRouters[a].address),
          ),
        ],
      ),
    });

    return updateTransactions;
  }

  createUnenrollRemoteRoutersUpdateTxs(
    actualConfig: DerivedTokenRouterConfig,
    expectedConfig: HypTokenRouterConfig,
  ): AnnotatedEV5Transaction[] {
    const updateTransactions: AnnotatedEV5Transaction[] = [];
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

    const contractToUpdate = TokenRouter__factory.connect(
      this.args.addresses.deployedTokenRoute,
      this.multiProvider.getProvider(this.domainId),
    );

    updateTransactions.push({
      annotation: `Unenrolling Router ${this.args.addresses.deployedTokenRoute} on ${this.args.chain}`,
      chainId: this.chainId,
      to: contractToUpdate.address,
      data: contractToUpdate.interface.encodeFunctionData(
        'unenrollRemoteRouters(uint32[])',
        [routesToUnenroll.map((k) => Number(k))],
      ),
    });

    return updateTransactions;
  }

  createAddRebalancersUpdateTxs(
    actualConfig: DerivedTokenRouterConfig,
    expectedConfig: HypTokenRouterConfig,
  ): AnnotatedEV5Transaction[] {
    actualConfig.type;
    if (
      !isMovableCollateralTokenConfig(expectedConfig) ||
      !isMovableCollateralTokenConfig(actualConfig)
    ) {
      return [];
    }

    if (!expectedConfig.allowedRebalancers) {
      return [];
    }

    const formattedExpectedRebalancers = new Set(
      expectedConfig.allowedRebalancers.map(normalizeAddressEvm),
    );
    const formattedActualRebalancers = new Set(
      (actualConfig.allowedRebalancers ?? []).map(normalizeAddressEvm),
    );

    const rebalancersToAdd = Array.from(
      difference(formattedExpectedRebalancers, formattedActualRebalancers),
    );

    if (rebalancersToAdd.length === 0) {
      return [];
    }

    return rebalancersToAdd.map((rebalancerToAdd) => ({
      chainId: this.chainId,
      annotation: `Adding rebalancer role to "${rebalancerToAdd}" on token "${this.args.addresses.deployedTokenRoute}" on chain "${this.chainName}"`,
      to: this.args.addresses.deployedTokenRoute,
      data: MovableCollateralRouter__factory.createInterface().encodeFunctionData(
        'addRebalancer(address)',
        [rebalancerToAdd],
      ),
    }));
  }

  createRemoveRebalancersUpdateTxs(
    actualConfig: DerivedTokenRouterConfig,
    expectedConfig: HypTokenRouterConfig,
  ): AnnotatedEV5Transaction[] {
    actualConfig.type;
    if (
      !isMovableCollateralTokenConfig(expectedConfig) ||
      !isMovableCollateralTokenConfig(actualConfig)
    ) {
      return [];
    }

    if (!expectedConfig.allowedRebalancers) {
      return [];
    }

    const formattedExpectedRebalancers = new Set(
      expectedConfig.allowedRebalancers.map(normalizeAddressEvm),
    );
    const formattedActualRebalancers = new Set(
      (actualConfig.allowedRebalancers ?? []).map(normalizeAddressEvm),
    );

    const rebalancersToRemove = Array.from(
      difference(formattedActualRebalancers, formattedExpectedRebalancers),
    );

    if (rebalancersToRemove.length === 0) {
      return [];
    }

    return rebalancersToRemove.map((rebalancerToRemove) => ({
      chainId: this.chainId,
      annotation: `Removing rebalancer role from "${rebalancerToRemove}" on token "${this.args.addresses.deployedTokenRoute}" on chain "${this.chainName}"`,
      to: this.args.addresses.deployedTokenRoute,
      data: MovableCollateralRouter__factory.createInterface().encodeFunctionData(
        'removeRebalancer(address)',
        [rebalancerToRemove],
      ),
    }));
  }

  async getAllowedBridgesApprovalTxs(
    actualConfig: DerivedTokenRouterConfig,
    expectedConfig: HypTokenRouterConfig,
  ): Promise<AnnotatedEV5Transaction[]> {
    if (
      !isMovableCollateralTokenConfig(expectedConfig) ||
      !isMovableCollateralTokenConfig(actualConfig)
    ) {
      return [];
    }

    if (!expectedConfig.allowedRebalancingBridges) {
      return [];
    }

    const tokensToApproveByAllowedBridge = Object.values(
      expectedConfig.allowedRebalancingBridges,
    ).reduce(
      (acc, allowedBridgesConfigs) => {
        allowedBridgesConfigs.forEach((bridgeConfig) => {
          acc[bridgeConfig.bridge] ??= [];
          acc[bridgeConfig.bridge].push(...(bridgeConfig.approvedTokens ?? []));
        });

        return acc;
      },
      // allowed bridge -> tokens to approve
      {} as Record<Address, Address[]>,
    );

    const filteredTokensToApproveByAllowedBridge = await promiseObjAll(
      objMap(tokensToApproveByAllowedBridge, async (bridge, tokens) => {
        const filteredApprovals = [];
        for (const token of tokens) {
          const instance = IERC20__factory.connect(
            token,
            this.multiProvider.getProvider(this.chainId),
          );

          const allowance = await instance.allowance(
            this.args.addresses.deployedTokenRoute,
            bridge,
          );

          if (allowance.toBigInt() !== UINT_256_MAX) {
            filteredApprovals.push(token);
          }
        }

        return filteredApprovals;
      }),
    );

    return Object.entries(filteredTokensToApproveByAllowedBridge).flatMap(
      ([bridge, tokensToApprove]) =>
        tokensToApprove.map((tokenToApprove) => ({
          chainId: this.chainId,
          annotation: `Approving allowed bridge "${bridge}" to spend token "${tokenToApprove}" on behalf of "${this.args.addresses.deployedTokenRoute}" on chain "${this.chainName}"`,
          to: this.args.addresses.deployedTokenRoute,
          data: MovableCollateralRouter__factory.createInterface().encodeFunctionData(
            'approveTokenForBridge(address,address)',
            [tokenToApprove, bridge],
          ),
        })),
    );
  }

  async createAddAllowedBridgesUpdateTxs(
    actualConfig: DerivedTokenRouterConfig,
    expectedConfig: HypTokenRouterConfig,
  ): Promise<AnnotatedEV5Transaction[]> {
    if (
      !isMovableCollateralTokenConfig(expectedConfig) ||
      !isMovableCollateralTokenConfig(actualConfig)
    ) {
      return [];
    }

    if (!expectedConfig.allowedRebalancingBridges) {
      return [];
    }

    const actualAllowedBridges = getAllowedRebalancingBridgesByDomain(
      resolveRouterMapConfig(
        this.multiProvider,
        actualConfig.allowedRebalancingBridges ?? {},
      ),
    );

    const expectedAllowedBridges = getAllowedRebalancingBridgesByDomain(
      resolveRouterMapConfig(
        this.multiProvider,
        expectedConfig.allowedRebalancingBridges,
      ),
    );
    const rebalancingBridgesToAddByDomain = objMap(
      expectedAllowedBridges,
      (domain, bridges) => {
        const actualBridges = actualAllowedBridges[domain] ?? new Set();

        return Array.from(difference(bridges, actualBridges));
      },
    );

    const bridgesToAllow = Object.entries(
      rebalancingBridgesToAddByDomain,
    ).flatMap(([domain, allowedBridgesToAdd]) => {
      return allowedBridgesToAdd.map((bridgeToAdd) => {
        return {
          chainId: this.chainId,
          annotation: `Adding allowed bridge "${bridgeToAdd}" on token "${this.args.addresses.deployedTokenRoute}" on chain "${this.chainName}"`,
          to: this.args.addresses.deployedTokenRoute,
          data: MovableCollateralRouter__factory.createInterface().encodeFunctionData(
            'addBridge(uint32,address)',
            [domain, bridgeToAdd],
          ),
        };
      });
    });

    const approvalTxs = await this.getAllowedBridgesApprovalTxs(
      actualConfig,
      expectedConfig,
    );
    return [...bridgesToAllow, ...approvalTxs];
  }

  createRemoveBridgesTxs(
    actualConfig: DerivedTokenRouterConfig,
    expectedConfig: HypTokenRouterConfig,
  ): AnnotatedEV5Transaction[] {
    if (
      !isMovableCollateralTokenConfig(expectedConfig) ||
      !isMovableCollateralTokenConfig(actualConfig)
    ) {
      return [];
    }

    if (!expectedConfig.allowedRebalancingBridges) {
      return [];
    }

    const actualAllowedBridges = getAllowedRebalancingBridgesByDomain(
      resolveRouterMapConfig(
        this.multiProvider,
        actualConfig.allowedRebalancingBridges ?? {},
      ),
    );
    const expectedAllowedBridges = getAllowedRebalancingBridgesByDomain(
      resolveRouterMapConfig(
        this.multiProvider,
        expectedConfig.allowedRebalancingBridges,
      ),
    );
    const rebalancingBridgesToAddByDomain = objMap(
      actualAllowedBridges,
      (domain, bridges) => {
        const expectedBridges = expectedAllowedBridges[domain] ?? new Set();

        return Array.from(difference(bridges, expectedBridges));
      },
    );

    return Object.entries(rebalancingBridgesToAddByDomain).flatMap(
      ([domain, allowedBridgesToAdd]) => {
        return allowedBridgesToAdd.map((bridgeToAdd) => {
          return {
            chainId: this.chainId,
            annotation: `Removing allowed bridge "${bridgeToAdd}" on token "${this.args.addresses.deployedTokenRoute}" on chain "${this.chainName}"`,
            to: this.args.addresses.deployedTokenRoute,
            data: MovableCollateralRouter__factory.createInterface().encodeFunctionData(
              'removeBridge(uint32,address)',
              [domain, bridgeToAdd],
            ),
          };
        });
      },
    );
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
  ): AnnotatedEV5Transaction[] {
    const updateTransactions: AnnotatedEV5Transaction[] = [];
    if (!expectedConfig.destinationGas) {
      return [];
    }

    assert(actualConfig.destinationGas, 'actualDestinationGas is undefined');
    assert(
      expectedConfig.destinationGas,
      'expectedDestinationGas is undefined',
    );

    const actualDestinationGas = resolveRouterMapConfig(
      this.multiProvider,
      actualConfig.destinationGas,
    );
    const expectedDestinationGas = resolveRouterMapConfig(
      this.multiProvider,
      expectedConfig.destinationGas,
    );

    if (!deepEquals(actualDestinationGas, expectedDestinationGas)) {
      const contractToUpdate = GasRouter__factory.connect(
        this.args.addresses.deployedTokenRoute,
        this.multiProvider.getProvider(this.domainId),
      );

      // Convert { 1: 2, 2: 3, ... } to [{ 1: 2 }, { 2: 3 }]
      const gasRouterConfigs: { domain: BigNumberish; gas: BigNumberish }[] =
        [];
      objMap(expectedDestinationGas, (domain: Domain, gas: string) => {
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
    actualConfig: DerivedTokenRouterConfig,
    expectedConfig: HypTokenRouterConfig,
  ): Promise<AnnotatedEV5Transaction[]> {
    const updateTransactions: AnnotatedEV5Transaction[] = [];
    if (
      !expectedConfig.interchainSecurityModule ||
      expectedConfig.interchainSecurityModule === zeroAddress
    ) {
      return [];
    }

    const actualDeployedIsm = derivedIsmAddress(actualConfig);

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

  async createHookUpdateTxs(
    actualConfig: DerivedTokenRouterConfig,
    expectedConfig: HypTokenRouterConfig,
  ): Promise<AnnotatedEV5Transaction[]> {
    const updateTransactions: AnnotatedEV5Transaction[] = [];

    if (!expectedConfig.hook || expectedConfig.hook === zeroAddress) {
      return [];
    }

    const actualDeployedHook = derivedHookAddress(actualConfig);

    // Try to deploy or update Hook with the expected config
    const {
      deployedHook: expectedDeployedHook,
      updateTransactions: hookUpdateTransactions,
    } = await this.deployOrUpdateHook(actualConfig, expectedConfig);

    // If a Hook is updated in-place, push the update txs
    updateTransactions.push(...hookUpdateTransactions);

    // If a new Hook is deployed, push the setHook tx
    if (!eqAddress(actualDeployedHook, expectedDeployedHook)) {
      const contractToUpdate = MailboxClient__factory.connect(
        this.args.addresses.deployedTokenRoute,
        this.multiProvider.getProvider(this.domainId),
      );
      updateTransactions.push({
        chainId: this.chainId,
        annotation: `Setting Hook for Warp Route to ${expectedDeployedHook}`,
        to: contractToUpdate.address,
        data: contractToUpdate.interface.encodeFunctionData('setHook', [
          expectedDeployedHook,
        ]),
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
  async deployOrUpdateIsm(
    actualConfig: DerivedTokenRouterConfig,
    expectedConfig: HypTokenRouterConfig,
  ): Promise<{
    deployedIsm: Address;
    updateTransactions: AnnotatedEV5Transaction[];
  }> {
    assert(expectedConfig.interchainSecurityModule, 'Ism derived incorrectly');

    const ismModule = new EvmIsmModule(
      this.multiProvider,
      {
        chain: this.args.chain,
        config: expectedConfig.interchainSecurityModule,
        addresses: {
          ...this.args.addresses,
          mailbox: expectedConfig.mailbox,
          deployedIsm: derivedIsmAddress(actualConfig),
        },
      },
      this.ccipContractCache,
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
   * Updates or deploys the hook using the provided configuration.
   *
   * @returns Object with deployedHook address, and update Transactions
   */
  async deployOrUpdateHook(
    actualConfig: DerivedTokenRouterConfig,
    expectedConfig: HypTokenRouterConfig,
  ): Promise<{
    deployedHook: Address;
    updateTransactions: AnnotatedEV5Transaction[];
  }> {
    assert(expectedConfig.hook, 'No hook config');
    if (!actualConfig.hook || actualConfig.hook === zeroAddress) {
      return this.deployNewHook(expectedConfig);
    }

    return this.updateExistingHook(expectedConfig, actualConfig);
  }

  async deployNewHook(expectedConfig: HypTokenRouterConfig): Promise<{
    deployedHook: Address;
    updateTransactions: AnnotatedEV5Transaction[];
  }> {
    this.logger.info(
      `No hook deployed for warp route, deploying new hook on ${this.args.chain} chain`,
    );

    assert(expectedConfig.hook, 'Hook is undefined');
    assert(
      expectedConfig.proxyAdmin?.address,
      'ProxyAdmin address is undefined',
    );

    const hookModule = await EvmHookModule.create({
      chain: this.args.chain,
      config: expectedConfig.hook,
      proxyFactoryFactories: extractIsmAndHookFactoryAddresses(
        this.args.addresses,
      ),
      coreAddresses: {
        mailbox: expectedConfig.mailbox,
        proxyAdmin: expectedConfig.proxyAdmin?.address, // Assume that a proxyAdmin is always deployed with a WarpRoute
      },
      contractVerifier: this.contractVerifier,
      multiProvider: this.multiProvider,
    });
    const { deployedHook } = hookModule.serialize();
    return { deployedHook, updateTransactions: [] };
  }

  async updateExistingHook(
    expectedConfig: HypTokenRouterConfig,
    actualConfig: DerivedTokenRouterConfig,
  ): Promise<{
    deployedHook: Address;
    updateTransactions: AnnotatedEV5Transaction[];
  }> {
    assert(actualConfig.proxyAdmin?.address, 'ProxyAdmin address is undefined');
    assert(actualConfig.hook, 'Hook is undefined');

    const hookModule = new EvmHookModule(
      this.multiProvider,
      {
        chain: this.args.chain,
        config: actualConfig.hook,
        addresses: {
          ...extractIsmAndHookFactoryAddresses(this.args.addresses),
          mailbox: actualConfig.mailbox,
          proxyAdmin: actualConfig.proxyAdmin?.address,
          deployedHook: derivedHookAddress(actualConfig),
        },
      },
      this.ccipContractCache,
      this.contractVerifier,
    );

    this.logger.info(
      `Comparing target Hook config with ${this.args.chain} chain`,
    );
    const updateTransactions = await hookModule.update(expectedConfig.hook!);
    const { deployedHook } = hookModule.serialize();

    return { deployedHook, updateTransactions };
  }

  /**
   * Creates a transaction to upgrade the Warp Route implementation if the package version is below specified version.
   *
   * @param actualConfig - The current on-chain configuration
   * @param expectedConfig - The expected configuration
   * @returns An array of transactions to upgrade the implementation if needed
   */
  async upgradeWarpRouteImplementationTx(
    actualConfig: DerivedTokenRouterConfig,
    expectedConfig: HypTokenRouterConfig,
  ): Promise<AnnotatedEV5Transaction[]> {
    const updateTransactions: AnnotatedEV5Transaction[] = [];

    // This should be impossible since we try catch the call to `PACKAGE_VERSION`
    // in `EvmERC20WarpRouteReader.fetchPackageVersion`
    assert(
      actualConfig.contractVersion,
      'Actual contract version is undefined',
    );

    // Only upgrade if the user specifies a version
    if (!expectedConfig.contractVersion) {
      return [];
    }

    const comparisonValue = compareVersions(
      expectedConfig.contractVersion,
      actualConfig.contractVersion,
    );

    // Expected version is lower than actual version, no upgrade is possible
    if (comparisonValue === -1) {
      throw new Error(
        `Expected contract version ${expectedConfig.contractVersion} is lower than actual contract version ${actualConfig.contractVersion}`,
      );
    }
    // Versions are the same, no upgrade needed
    if (comparisonValue === 0) {
      return [];
    }

    // You can only upgrade to the contract version (see `PackageVersioned`)
    // defined by the @hyperlane-xyz/core package
    assert(
      contractVersionMatchesDependency(expectedConfig.contractVersion),
      VERSION_ERROR_MESSAGE,
    );

    this.logger.info(
      `Upgrading Warp Route implementation on ${this.args.chain} from ${actualConfig.contractVersion} to ${expectedConfig.contractVersion}`,
    );

    const deployer = new HypERC20Deployer(this.multiProvider);
    const constructorArgs = await deployer.constructorArgs(
      this.chainName,
      expectedConfig,
    );
    const implementation = await deployer.deployContract(
      this.chainName,
      expectedConfig.type,
      constructorArgs,
    );

    const provider = this.multiProvider.getProvider(this.domainId);
    const proxyAddress = this.args.addresses.deployedTokenRoute;
    const proxyAdminAddress = await proxyAdmin(provider, proxyAddress);

    assert(
      await isInitialized(provider, proxyAddress),
      'Proxy is not initialized',
    );

    updateTransactions.push({
      chainId: this.chainId,
      annotation: `Upgrading Warp Route implementation on ${this.args.chain}`,
      to: proxyAdminAddress,
      data: ProxyAdmin__factory.createInterface().encodeFunctionData(
        'upgrade',
        [proxyAddress, implementation.address],
      ),
    });

    return updateTransactions;
  }

  /**
   * Deploys the Warp Route.
   *
   * @param chain - The chain to deploy the module on.
   * @param config - The configuration for the token router.
   * @param multiProvider - The multi-provider instance to use.
   * @returns A new instance of the EvmERC20WarpHyperlaneModule.
   */
  static async create(params: {
    chain: ChainNameOrId;
    config: HypTokenRouterConfig;
    multiProvider: MultiProvider;
    ccipContractCache?: CCIPContractCache;
    contractVerifier?: ContractVerifier;
    proxyFactoryFactories: HyperlaneAddresses<ProxyFactoryFactories>;
  }): Promise<EvmERC20WarpModule> {
    const {
      chain,
      config,
      multiProvider,
      ccipContractCache,
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
      ccipContractCache,
      contractVerifier,
    );

    const actualConfig = await warpModule.read();
    if (config.remoteRouters && !isObjEmpty(config.remoteRouters)) {
      const enrollRemoteTxs =
        await warpModule.createEnrollRemoteRoutersUpdateTxs(
          actualConfig,
          config,
        ); // @TODO Remove when EvmERC20WarpModule.create can be used
      const onlyTxIndex = 0;
      await multiProvider.sendTransaction(chain, enrollRemoteTxs[onlyTxIndex]);
    }

    if (
      isMovableCollateralTokenConfig(config) &&
      config.allowedRebalancers &&
      config.allowedRebalancers.length !== 0
    ) {
      const addRebalancerTxs = await warpModule.createAddRebalancersUpdateTxs(
        actualConfig,
        config,
      ); // @TODO Remove when EvmERC20WarpModule.create can be used

      for (const tx of addRebalancerTxs) {
        await multiProvider.sendTransaction(chain, tx);
      }
    }

    if (
      isMovableCollateralTokenConfig(config) &&
      config.allowedRebalancingBridges &&
      !isObjEmpty(config.allowedRebalancingBridges)
    ) {
      const addBridgesTxs = await warpModule.createAddAllowedBridgesUpdateTxs(
        actualConfig,
        config,
      ); // @TODO Remove when EvmERC20WarpModule.create can be used

      for (const tx of addBridgesTxs) {
        await multiProvider.sendTransaction(chain, tx);
      }
    }

    return warpModule;
  }

  protected async createFeeRecipientUpdateTxs(
    actual: DerivedTokenRouterConfig,
    expected: HypTokenRouterConfig,
  ): Promise<AnnotatedEV5Transaction[]> {
    if (deepEquals(actual.tokenFee, expected.tokenFee)) {
      return [];
    }

    if (expected.tokenFee) {
      const deployer = new HypERC20Deployer(this.multiProvider);
      const feeRecipient = await deployer.deployFeeRecipient(
        this.chainName,
        expected.tokenFee,
      );
      return [
        {
          chainId: this.chainId,
          annotation: `Setting fee recipient to ${feeRecipient} (${expected.tokenFee.type})`,
          to: this.args.addresses.deployedTokenRoute,
          data: FungibleTokenRouter__factory.createInterface().encodeFunctionData(
            'setFeeRecipient',
            [feeRecipient],
          ),
        },
      ];
    }

    return [];
  }
}
