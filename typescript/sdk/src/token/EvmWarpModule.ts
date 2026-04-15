// import { expect } from 'chai';
import { compareVersions } from 'compare-versions';
import { BigNumberish, constants, providers } from 'ethers';
import { UINT_256_MAX } from 'starknet';

import {
  CrossCollateralRouter__factory,
  EverclearTokenBridge__factory,
  GasRouter__factory,
  IERC20__factory,
  MailboxClient__factory,
  MovableCollateralRouter__factory,
  PredicateRouterWrapper__factory,
  ProxyAdmin__factory,
  StaticAggregationHook__factory,
  StaticAggregationHookFactory__factory,
  TokenBridgeCctpV2__factory,
  TokenRouter__factory,
} from '@hyperlane-xyz/core';
import { buildArtifact as coreBuildArtifact } from '@hyperlane-xyz/core/buildArtifact.js';
import {
  Address,
  Domain,
  EvmChainId,
  ProtocolType,
  ZERO_ADDRESS_HEX_32,
  addressToBytes32,
  assert,
  deepEquals,
  difference,
  eqAddress,
  isAddressEvm,
  isNullish,
  isObjEmpty,
  isZeroishAddress,
  normalizeAddressEvm,
  objDiff,
  objFilter,
  objKeys,
  objMap,
  promiseObjAll,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { ExplorerLicenseType } from '../block-explorer/etherscan.js';
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
import { EvmTokenFeeModule } from '../fee/EvmTokenFeeModule.js';
import { TokenFeeReaderParams } from '../fee/EvmTokenFeeReader.js';
import { getEvmHookUpdateTransactions } from '../hook/updates.js';
import { stripPredicateSubHook } from '../hook/utils.js';
import { DerivedHookConfig, OnchainHookType } from '../hook/types.js';
import { EvmIsmModule } from '../ism/EvmIsmModule.js';
import { PredicateWrapperDeployer } from '../predicate/PredicateDeployer.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { AnnotatedEV5Transaction } from '../providers/ProviderType.js';
import { RemoteRouters, resolveRouterMapConfig } from '../router/types.js';
import { ChainName, ChainNameOrId } from '../types.js';
import { scalesEqual } from '../utils/decimals.js';
import { extractIsmAndHookFactoryAddresses } from '../utils/ism.js';

import {
  CCTP_PPM_STORAGE_VERSION,
  EvmWarpRouteReader,
} from './EvmWarpRouteReader.js';
import { EvmXERC20Module } from './EvmXERC20Module.js';
import { DeployableTokenType, TokenType } from './config.js';
import { resolveTokenFeeAddress } from './configUtils.js';
import { hypERC20contracts } from './contracts.js';
import { HypERC20Deployer } from './deploy.js';
import {
  DerivedTokenRouterConfig,
  EverclearCollateralTokenConfig,
  HypTokenRouterConfig,
  HypTokenRouterConfigSchema,
  MovableTokenConfig,
  PredicateWrapperConfig,
  PredicateWrapperConfigSchema,
  VERSION_ERROR_MESSAGE,
  contractVersionMatchesDependency,
  derivedHookAddress,
  derivedIsmAddress,
  isCctpTokenConfig,
  isEverclearTokenBridgeConfig,
  isMovableCollateralTokenConfig,
  isCrossCollateralTokenConfig,
  isOftTokenConfig,
  isXERC20TokenConfig,
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
export class EvmWarpModule extends HyperlaneModule<
  ProtocolType.Ethereum,
  HypTokenRouterConfig,
  WarpRouteAddresses
> {
  protected logger = rootLogger.child({
    module: 'EvmWarpModule',
  });
  reader: EvmWarpRouteReader;
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
    this.reader = new EvmWarpRouteReader(multiProvider, args.chain);
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
   * IMPORTANT — irreversible side effects when expectedConfig includes `predicateWrapper`:
   * The PredicateRouterWrapper contract is deployed on-chain during planning (before this
   * method returns). If the returned transactions are never submitted, the wrapper is
   * orphaned. See PredicateWrapperDeployer.deployAndConfigure for details.
   *
   * @param expectedConfig - The configuration for the token router to be updated.
   * @returns An array of Ethereum transactions that were executed to update the contract, or an error if the update failed.
   */
  async update(
    expectedConfig: HypTokenRouterConfig,
    tokenReaderParams?: Partial<TokenFeeReaderParams>,
  ): Promise<AnnotatedEV5Transaction[]> {
    HypTokenRouterConfigSchema.parse(expectedConfig);
    const actualConfig = await this.read();
    const transactions = [];

    let xerc20Txs: AnnotatedEV5Transaction[] = [];
    if (isXERC20TokenConfig(expectedConfig)) {
      const { module, config } = await EvmXERC20Module.fromWarpRouteConfig(
        this.multiProvider,
        this.chainName,
        expectedConfig,
        this.args.addresses.deployedTokenRoute,
      );
      xerc20Txs = await module.update(config);
    }

    /**
     * @remark
     * The order of operations matter
     * 1. createOwnershipUpdateTxs() must always be LAST because no updates possible after ownership transferred
     * 2. createEnrollRemoteRoutersUpdateTxs() must be BEFORE createSetDestinationGasUpdateTxs()
     *    because GasRouter requires routers to be enrolled before setting destination gas
     * 3. createHookAndPredicateUpdateTxs() handles hook + predicate wrapper together so the
     *    pending new hook address is threaded through without leaking into other method signatures
     */
    transactions.push(
      ...(await this.upgradeWarpRouteImplementationTx(
        actualConfig,
        expectedConfig,
      )),
      ...(await this.createIsmUpdateTxs(actualConfig, expectedConfig)),
      ...(await this.createHookAndPredicateUpdateTxs(
        actualConfig,
        expectedConfig,
      )),
      ...(await this.createTokenFeeUpdateTxs(
        actualConfig,
        expectedConfig,
        tokenReaderParams,
      )),
      ...this.createUnenrollRemoteRoutersUpdateTxs(
        actualConfig,
        expectedConfig,
      ),
      ...this.createEnrollRemoteRoutersUpdateTxs(actualConfig, expectedConfig),
      // MC unenroll before enroll for consistency with remote routers.
      // MC enrollment must come before gas setting so that MC-only domains
      ...this.createUnenrollCrossCollateralRoutersTxs(
        actualConfig,
        expectedConfig,
      ),
      ...this.createEnrollCrossCollateralRoutersTxs(
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

      ...this.createAddRemoteOutputAssetsTxs(actualConfig, expectedConfig),
      ...this.createRemoveRemoteOutputAssetsTxs(actualConfig, expectedConfig),

      ...this.createUpdateEverclearFeeParamsTxs(actualConfig, expectedConfig),
      ...this.createRemoveEverclearFeeParamsTxs(actualConfig, expectedConfig),
      ...this.createSetMaxFeePpmTxs(actualConfig, expectedConfig),
      ...xerc20Txs,

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
    // OFT contracts don't have Router interface — no remote router enrollment
    if (isOftTokenConfig(expectedConfig)) {
      return [];
    }
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
    // OFT contracts don't have Router interface — no remote router unenrollment
    if (isOftTokenConfig(expectedConfig)) {
      return [];
    }
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

  /**
   * Create transactions to enroll CrossCollateralRouter routers.
   */
  createEnrollCrossCollateralRoutersTxs(
    actualConfig: DerivedTokenRouterConfig,
    expectedConfig: HypTokenRouterConfig,
  ): AnnotatedEV5Transaction[] {
    if (
      !isCrossCollateralTokenConfig(expectedConfig) ||
      !isCrossCollateralTokenConfig(actualConfig)
    ) {
      return [];
    }

    if (!expectedConfig.crossCollateralRouters) {
      return [];
    }

    const actualEnrolled = resolveRouterMapConfig(
      this.multiProvider,
      actualConfig.crossCollateralRouters ?? {},
    );
    const expectedEnrolled = resolveRouterMapConfig(
      this.multiProvider,
      expectedConfig.crossCollateralRouters,
    );

    const domainsToEnroll: number[] = [];
    const routersToEnroll: string[] = [];

    for (const [domain, expectedRouters] of Object.entries(expectedEnrolled)) {
      const domainId = Number(domain);
      const actualRouters = new Set(
        (actualEnrolled[domainId] ?? []).map((router) =>
          this.toCanonicalRouterId(router),
        ),
      );
      for (const router of expectedRouters) {
        const canonicalRouter = this.toCanonicalRouterId(router);
        if (!actualRouters.has(canonicalRouter)) {
          domainsToEnroll.push(domainId);
          routersToEnroll.push(canonicalRouter);
        }
      }
    }

    if (domainsToEnroll.length === 0) {
      return [];
    }

    return [
      {
        chainId: this.chainId,
        annotation: `Enrolling ${domainsToEnroll.length} CrossCollateralRouter routers on ${this.args.addresses.deployedTokenRoute} on ${this.chainName}`,
        to: this.args.addresses.deployedTokenRoute,
        data: CrossCollateralRouter__factory.createInterface().encodeFunctionData(
          'enrollCrossCollateralRouters',
          [domainsToEnroll, routersToEnroll],
        ),
      },
    ];
  }

  /**
   * Create transactions to unenroll CrossCollateralRouter routers.
   */
  createUnenrollCrossCollateralRoutersTxs(
    actualConfig: DerivedTokenRouterConfig,
    expectedConfig: HypTokenRouterConfig,
  ): AnnotatedEV5Transaction[] {
    if (
      !isCrossCollateralTokenConfig(expectedConfig) ||
      !isCrossCollateralTokenConfig(actualConfig)
    ) {
      return [];
    }
    const expectedCrossCollateralRouters =
      expectedConfig.crossCollateralRouters ?? {};

    const actualEnrolled = resolveRouterMapConfig(
      this.multiProvider,
      actualConfig.crossCollateralRouters ?? {},
    );
    const expectedEnrolled = resolveRouterMapConfig(
      this.multiProvider,
      expectedCrossCollateralRouters,
    );

    const domainsToUnenroll: number[] = [];
    const routersToUnenroll: string[] = [];

    for (const [domain, actualRouters] of Object.entries(actualEnrolled)) {
      const domainId = Number(domain);
      const expectedRouters = new Set(
        (expectedEnrolled[domainId] ?? []).map((router) =>
          this.toCanonicalRouterId(router),
        ),
      );
      for (const router of actualRouters) {
        const canonicalRouter = this.toCanonicalRouterId(router);
        if (!expectedRouters.has(canonicalRouter)) {
          domainsToUnenroll.push(domainId);
          routersToUnenroll.push(canonicalRouter);
        }
      }
    }

    if (domainsToUnenroll.length === 0) {
      return [];
    }

    return [
      {
        chainId: this.chainId,
        annotation: `Unenrolling ${domainsToUnenroll.length} CrossCollateralRouter routers on ${this.args.addresses.deployedTokenRoute} on ${this.chainName}`,
        to: this.args.addresses.deployedTokenRoute,
        data: CrossCollateralRouter__factory.createInterface().encodeFunctionData(
          'unenrollCrossCollateralRouters',
          [domainsToUnenroll, routersToUnenroll],
        ),
      },
    ];
  }

  private toCanonicalRouterId(router: string): string {
    const lower = router.toLowerCase();
    if (isAddressEvm(lower)) {
      return addressToBytes32(lower);
    }
    return lower;
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

  createAddRemoteOutputAssetsTxs(
    actualConfig: DerivedTokenRouterConfig,
    expectedConfig: HypTokenRouterConfig,
  ): AnnotatedEV5Transaction[] {
    if (
      !isEverclearTokenBridgeConfig(expectedConfig) ||
      !isEverclearTokenBridgeConfig(actualConfig)
    ) {
      return [];
    }

    const actualOutputAssets = resolveRouterMapConfig(
      this.multiProvider,
      actualConfig.outputAssets,
    );
    const expectedOutputAssets = resolveRouterMapConfig(
      this.multiProvider,
      expectedConfig.outputAssets,
    );

    const outputAssetsToAdd = objDiff(
      expectedOutputAssets,
      actualOutputAssets,
      (address, address2) =>
        addressToBytes32(address) === addressToBytes32(address2),
    );
    if (isObjEmpty(outputAssetsToAdd)) {
      return [];
    }

    const assets = Object.entries(outputAssetsToAdd).map(
      ([domainId, outputAsset]): {
        destination: number;
        outputAsset: string;
      } => ({
        destination: parseInt(domainId),
        outputAsset: addressToBytes32(outputAsset),
      }),
    );

    return [
      {
        chainId: this.multiProvider.getEvmChainId(this.chainId),
        to: this.args.addresses.deployedTokenRoute,
        annotation: `Adding "${Object.keys(assets)}" output assets for token "${this.args.addresses.deployedTokenRoute}" on chain "${this.chainName}"`,
        data: EverclearTokenBridge__factory.createInterface().encodeFunctionData(
          'setOutputAssetsBatch((uint32,bytes32)[])',
          [assets],
        ),
      },
    ];
  }

  createRemoveRemoteOutputAssetsTxs(
    actualConfig: DerivedTokenRouterConfig,
    expectedConfig: HypTokenRouterConfig,
  ): AnnotatedEV5Transaction[] {
    if (
      !isEverclearTokenBridgeConfig(expectedConfig) ||
      !isEverclearTokenBridgeConfig(actualConfig)
    ) {
      return [];
    }

    const actualOutputAssets = resolveRouterMapConfig(
      this.multiProvider,
      actualConfig.outputAssets,
    );
    const expectedOutputAssets = resolveRouterMapConfig(
      this.multiProvider,
      expectedConfig.outputAssets,
    );

    const outputAssetsToRemove = Array.from(
      difference(
        new Set(objKeys(actualOutputAssets)),
        new Set(objKeys(expectedOutputAssets)),
      ),
    );

    if (outputAssetsToRemove.length === 0) {
      return [];
    }

    const assets = outputAssetsToRemove.map(
      (
        domainId,
      ): {
        destination: number;
        outputAsset: string;
      } => ({
        destination: domainId,
        outputAsset: ZERO_ADDRESS_HEX_32,
      }),
    );

    return [
      {
        chainId: this.multiProvider.getEvmChainId(this.chainId),
        to: this.args.addresses.deployedTokenRoute,
        annotation: `Removing "${outputAssetsToRemove}" output assets from token "${this.args.addresses.deployedTokenRoute}" on chain "${this.chainName}"`,
        data: EverclearTokenBridge__factory.createInterface().encodeFunctionData(
          'setOutputAssetsBatch((uint32,bytes32)[])',
          [assets],
        ),
      },
    ];
  }

  createUpdateEverclearFeeParamsTxs(
    actualConfig: DerivedTokenRouterConfig,
    expectedConfig: HypTokenRouterConfig,
  ): AnnotatedEV5Transaction[] {
    if (
      !isEverclearTokenBridgeConfig(expectedConfig) ||
      !isEverclearTokenBridgeConfig(actualConfig)
    ) {
      return [];
    }

    if (
      deepEquals(
        expectedConfig.everclearFeeParams,
        actualConfig.everclearFeeParams,
      )
    ) {
      return [];
    }

    const resolvedEverclearExpectedFeeConfig = resolveRouterMapConfig(
      this.multiProvider,
      expectedConfig.everclearFeeParams,
    );
    const resolvedActualEverclearFeeConfig = resolveRouterMapConfig(
      this.multiProvider,
      actualConfig.everclearFeeParams,
    );

    const feesToSet = objFilter(
      resolvedEverclearExpectedFeeConfig,
      (
        domainId,
        currentDomainConfig,
      ): currentDomainConfig is EverclearCollateralTokenConfig['everclearFeeParams'][number] => {
        return (
          isNullish(resolvedActualEverclearFeeConfig[Number(domainId)]) ||
          !deepEquals(
            currentDomainConfig,
            resolvedActualEverclearFeeConfig[Number(domainId)],
          )
        );
      },
    );

    return Object.entries(feesToSet).map(([domainId, feeConfig]) => {
      const { deadline, fee, signature } = feeConfig;

      // Deadline is in seconds
      const humanReadableDeadline = new Date(deadline * 1000).toISOString();
      return {
        annotation: `Setting Everclear fee params with deadline "${humanReadableDeadline}" for domain "${domainId}" on token "${this.args.addresses.deployedTokenRoute}" and chain "${this.chainName}"`,
        chainId: this.multiProvider.getEvmChainId(this.chainName),
        to: this.args.addresses.deployedTokenRoute,
        data: EverclearTokenBridge__factory.createInterface().encodeFunctionData(
          'setFeeParams',
          [domainId, fee, deadline, signature],
        ),
      };
    });
  }

  createRemoveEverclearFeeParamsTxs(
    actualConfig: DerivedTokenRouterConfig,
    expectedConfig: HypTokenRouterConfig,
  ): AnnotatedEV5Transaction[] {
    if (
      !isEverclearTokenBridgeConfig(expectedConfig) ||
      !isEverclearTokenBridgeConfig(actualConfig)
    ) {
      return [];
    }

    const resolvedEverclearExpectedFeeConfig = resolveRouterMapConfig(
      this.multiProvider,
      expectedConfig.everclearFeeParams,
    );
    const resolvedActualEverclearFeeConfig = resolveRouterMapConfig(
      this.multiProvider,
      actualConfig.everclearFeeParams,
    );

    const outputAssetsToRemove = Array.from(
      difference(
        new Set(objKeys(resolvedActualEverclearFeeConfig)),
        new Set(objKeys(resolvedEverclearExpectedFeeConfig)),
      ),
    );

    if (outputAssetsToRemove.length === 0) {
      return [];
    }

    return outputAssetsToRemove.map((domainId) => {
      return {
        annotation: `Removing Everclear fee params for domain "${domainId}" on token "${this.args.addresses.deployedTokenRoute}" and chain "${this.chainName}"`,
        chainId: this.multiProvider.getEvmChainId(this.chainName),
        to: this.args.addresses.deployedTokenRoute,
        data: EverclearTokenBridge__factory.createInterface().encodeFunctionData(
          'setFeeParams',
          // Setting default values to reset the config for the provided domain
          [domainId, 0, 0, '0x'],
        ),
      };
    });
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
    // OFT contracts don't have GasRouter interface — no destination gas config
    if (isOftTokenConfig(expectedConfig)) {
      return [];
    }
    const updateTransactions: AnnotatedEV5Transaction[] = [];
    if (!expectedConfig.destinationGas) {
      return [];
    }

    assert(actualConfig.destinationGas, 'actualDestinationGas is undefined');
    assert(
      expectedConfig.destinationGas,
      'expectedDestinationGas is undefined',
    );

    // Only set gas for domains that will have routers enrolled after the update.
    // For CrossCollateralRouter configs, also include domains from crossCollateralRouters.
    const resolvedExpectedRemoteRouters = resolveRouterMapConfig(
      this.multiProvider,
      expectedConfig.remoteRouters ?? {},
    );
    const expectedRouterDomains = new Set(
      Object.keys(resolvedExpectedRemoteRouters).map(Number),
    );

    // Include MC-enrolled router domains
    if (
      isCrossCollateralTokenConfig(expectedConfig) &&
      expectedConfig.crossCollateralRouters
    ) {
      const localDomain = this.multiProvider.getDomainId(this.chainName);
      const resolvedEnrolled = resolveRouterMapConfig(
        this.multiProvider,
        expectedConfig.crossCollateralRouters,
      );
      for (const domain of Object.keys(resolvedEnrolled).map(Number)) {
        if (domain === localDomain) continue;
        expectedRouterDomains.add(domain);
      }
    }

    if (
      expectedRouterDomains.size === 0 &&
      Object.keys(expectedConfig.destinationGas).length > 0
    ) {
      throw new Error(
        `destinationGas is set but remoteRouters and crossCollateralRouters are empty. ` +
          `Cannot configure gas for domains without corresponding router enrollments.`,
      );
    }

    const actualDestinationGas = resolveRouterMapConfig(
      this.multiProvider,
      actualConfig.destinationGas,
    );
    const expectedDestinationGas = resolveRouterMapConfig(
      this.multiProvider,
      expectedConfig.destinationGas,
    );

    // Filter to only domains that will have routers enrolled
    const filteredExpectedGas = Object.fromEntries(
      Object.entries(expectedDestinationGas).filter(([domain]) =>
        expectedRouterDomains.has(Number(domain)),
      ),
    );

    // Filter actual gas to the same domains for comparison
    const filteredActualGas = Object.fromEntries(
      Object.entries(actualDestinationGas).filter(([domain]) =>
        expectedRouterDomains.has(Number(domain)),
      ),
    );

    if (!deepEquals(filteredActualGas, filteredExpectedGas)) {
      // Convert { 1: 2, 2: 3, ... } to [{ 1: 2 }, { 2: 3 }]
      const gasRouterConfigs: {
        domain: BigNumberish;
        gas: BigNumberish;
      }[] = [];
      objMap(filteredExpectedGas, (domain: Domain, gas: string) => {
        gasRouterConfigs.push({
          domain,
          gas,
        });
      });

      const contractToUpdate = GasRouter__factory.connect(
        this.args.addresses.deployedTokenRoute,
        this.multiProvider.getProvider(this.domainId),
      );

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
    if (!expectedConfig.interchainSecurityModule) {
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
    if (!eqAddress(actualDeployedIsm, expectedDeployedIsm)) {
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
    return this.createHookAndPredicateUpdateTxs(actualConfig, expectedConfig);
  }

  /**
   * Deploys hook updates and predicate wrapper together so the post-update hook address
   * is available to deployAndConfigure without a stale on-chain read.
   */
  async createHookAndPredicateUpdateTxs(
    actualConfig: DerivedTokenRouterConfig,
    expectedConfig: HypTokenRouterConfig,
  ): Promise<AnnotatedEV5Transaction[]> {
    let hookTransactions: AnnotatedEV5Transaction[] = [];
    let newHookAddress: Address | undefined;

    // Explicit type annotation narrows away the undefined that TypeScript infers
    // from the RouterConfig & DerivedMailboxClientConfig intersection.
    const actualHook: DerivedHookConfig | string = actualConfig.hook;

    // Predicate removal: on-chain wrapper exists but expected config omits it.
    // When the user provides an explicit expectedConfig.hook the normal hook-diff
    // path handles removal (the new hook replaces the aggregation). When no hook
    // is provided we must generate a setHook call to unwrap the aggregation and
    // restore the bare underlying hook.
    const needsPredicateRemoval =
      actualConfig.predicateWrapper != null && !expectedConfig.predicateWrapper;

    // Treat a zero-address hook the same as "no explicit hook": expandWarpDeployConfig
    // sets hook: zeroAddress as a default when the user config omits the hook field.
    // EvmHookModule.update(zeroAddress) returns [] early without updating deployedHook,
    // so a zero-address target produces no setHook tx and the predicate removal branch
    // would never be reached. Exclude zero addresses so needsPredicateRemoval can fire.
    if (
      expectedConfig.hook &&
      (typeof expectedConfig.hook !== 'string' ||
        !isZeroishAddress(expectedConfig.hook))
    ) {
      const proxyAdminAddress =
        expectedConfig.proxyAdmin?.address ?? actualConfig.proxyAdmin?.address;
      assert(proxyAdminAddress, 'ProxyAdmin address is undefined');

      // The reader leaves the PREDICATE sub-hook inside actualConfig.hook
      // (e.g. Agg([Predicate, IGP])). When expectedConfig is derived from
      // actualConfig (e.g. during the enrollment step after initial deploy),
      // expectedConfig.hook carries the same aggregation. Strip the predicate
      // from BOTH sides so the hook diff sees the bare hook (IGP) on both sides
      // and doesn't generate a spurious setHook.
      const actualHookForComparison = expectedConfig.predicateWrapper
        ? stripPredicateSubHook(actualHook)
        : actualHook;
      const expectedHookForComparison =
        expectedConfig.predicateWrapper && expectedConfig.hook
          ? stripPredicateSubHook(
              expectedConfig.hook as DerivedHookConfig | string,
            )
          : expectedConfig.hook;

      const result = await getEvmHookUpdateTransactions(
        this.args.addresses.deployedTokenRoute,
        {
          actualConfig: actualHookForComparison,
          expectedConfig: expectedHookForComparison,
          ccipContractCache: this.ccipContractCache,
          contractVerifier: this.contractVerifier,
          evmChainName: this.chainName,
          hookAndIsmFactories: extractIsmAndHookFactoryAddresses(
            this.args.addresses,
          ),
          setHookFunctionCallEncoder: (addr: string) =>
            MailboxClient__factory.createInterface().encodeFunctionData(
              'setHook',
              [addr],
            ),
          logger: this.logger,
          mailbox: actualConfig.mailbox,
          multiProvider: this.multiProvider,
          proxyAdminAddress,
        },
      );
      hookTransactions = result.transactions;
      newHookAddress = result.newHookAddress;
    } else if (needsPredicateRemoval) {
      // No explicit target hook. Restore the bare underlying hook by stripping
      // the predicate sub-hook from the current aggregation and calling setHook
      // with the resulting address.
      const strippedHook = stripPredicateSubHook(actualHook);
      const underlyingAddress =
        typeof strippedHook === 'string' ? strippedHook : strippedHook.address;
      const currentAddress =
        typeof actualHook === 'string' ? actualHook : actualHook.address;

      if (underlyingAddress !== currentAddress) {
        this.logger.debug(
          { chain: this.chainName, underlyingAddress },
          'Removing predicate wrapper: generating setHook to restore bare underlying hook',
        );
        hookTransactions.push({
          annotation:
            'Remove predicate wrapper: restore router hook to bare underlying hook',
          chainId: this.chainId,
          to: this.args.addresses.deployedTokenRoute,
          data: MailboxClient__factory.createInterface().encodeFunctionData(
            'setHook',
            [underlyingAddress],
          ),
        });
      }
    }

    const { transactions: predicateTransactions, deploysNewWrapper } =
      await this.createPredicateWrapperUpdateTxs(
        actualConfig,
        expectedConfig,
        newHookAddress,
      );

    // When predicate wrapper is being deployed, its setHook(aggregation) sets the final
    // router hook and already incorporates newHookAddress inside the aggregation.
    // Drop the intermediate setHook(newHookAddress) from hookTransactions to avoid a
    // redundant write that would be immediately overwritten.
    //
    // IMPORTANT: only drop when a NEW wrapper is being deployed. The ownership-only
    // path (deploysNewWrapper=false) must not suppress the hook update even though
    // predicateTransactions is non-empty.
    const effectiveHookTransactions =
      hookTransactions.length > 0 && deploysNewWrapper
        ? hookTransactions.filter(
            (tx) =>
              !(
                tx.to &&
                eqAddress(tx.to, this.args.addresses.deployedTokenRoute) &&
                tx.data?.startsWith(
                  MailboxClient__factory.createInterface().getSighash(
                    'setHook',
                  ),
                )
              ),
          )
        : hookTransactions;

    return [...effectiveHookTransactions, ...predicateTransactions];
  }

  /**
   * Searches the current on-chain hook tree for a PredicateRouterWrapper that
   * matches by registry and policyId. Returns the wrapper address and its current
   * on-chain owner when found, undefined otherwise.
   *
   * Uses unbounded recursion into aggregation hooks (consistent with
   * EvmTokenAdapter.findPredicateWrapperInHook and EvmWarpRouteReader.findPredicateAddressInHook).
   */
  private async findDeployedPredicateWrapper(
    actualConfig: DerivedTokenRouterConfig,
    expectedPredicateConfig: { predicateRegistry: string; policyId: string },
  ): Promise<{ address: Address; onchainOwner: Address } | undefined> {
    const hookAddress = derivedHookAddress(actualConfig);
    if (!hookAddress || isZeroishAddress(hookAddress)) return undefined;

    try {
      const provider = this.multiProvider.getProvider(this.domainId);
      return await this.searchPredicateInHook(
        hookAddress,
        provider,
        expectedPredicateConfig,
      );
    } catch (error) {
      this.logger.debug(
        { chain: this.chainName, error },
        'Error checking predicate wrapper deployment',
      );
    }
    return undefined;
  }

  /**
   * Recursively searches a hook tree for a matching PredicateRouterWrapper.
   * Descends into StaticAggregationHook sub-hooks without depth limit.
   */
  private async searchPredicateInHook(
    hookAddr: Address,
    provider: providers.Provider,
    expectedPredicateConfig: { predicateRegistry: string; policyId: string },
  ): Promise<{ address: Address; onchainOwner: Address } | undefined> {
    const match = await this.matchPredicateWrapper(
      hookAddr,
      provider,
      expectedPredicateConfig,
    );
    if (match) return match;

    let subHooks: string[];
    try {
      subHooks = await StaticAggregationHook__factory.connect(
        hookAddr,
        provider,
      ).hooks('0x');
    } catch {
      // Any call failure means hookAddr is not a StaticAggregationHook.
      // HyperlaneSmartProvider wraps CALL_EXCEPTION as "Invalid response from provider"
      // with code: undefined, so checking error.code is insufficient.
      return undefined;
    }

    for (const subHook of subHooks) {
      const found = await this.searchPredicateInHook(
        subHook,
        provider,
        expectedPredicateConfig,
      );
      if (found) return found;
    }
    return undefined;
  }

  /**
   * Checks whether a single hook address is a PredicateRouterWrapper matching
   * the warp route and expected config. Returns the match or undefined.
   */
  private async matchPredicateWrapper(
    hookAddr: Address,
    provider: providers.Provider,
    expectedPredicateConfig: { predicateRegistry: string; policyId: string },
  ): Promise<{ address: Address; onchainOwner: Address } | undefined> {
    try {
      const predicateWrapper = PredicateRouterWrapper__factory.connect(
        hookAddr,
        provider,
      );

      // Verify identity: warpRoute + hookType confirm it's a PredicateRouterWrapper
      // for this route. Then compare registry + policyId so config rotations
      // (e.g. changing compliance policy) trigger a redeploy rather than silently no-op.
      const [
        warpRoute,
        hookType,
        onchainRegistry,
        onchainPolicyId,
        onchainOwner,
      ] = await Promise.all([
        predicateWrapper.warpRoute(),
        predicateWrapper.hookType(),
        predicateWrapper.getRegistry(),
        predicateWrapper.getPolicyID(),
        predicateWrapper.owner(),
      ]);

      if (
        eqAddress(warpRoute, this.args.addresses.deployedTokenRoute) &&
        hookType === OnchainHookType.PREDICATE_ROUTER_WRAPPER &&
        eqAddress(onchainRegistry, expectedPredicateConfig.predicateRegistry) &&
        onchainPolicyId === expectedPredicateConfig.policyId
      ) {
        return { address: hookAddr, onchainOwner };
      }
    } catch {
      // Any call failure means hookAddr is not a PredicateRouterWrapper.
      // HyperlaneSmartProvider wraps CALL_EXCEPTION as "Invalid response from provider"
      // with code: undefined, so checking error.code === 'CALL_EXCEPTION' is insufficient.
      return undefined;
    }
    return undefined;
  }

  /**
   * Check if predicate wrapper is already deployed with fully matching config
   * (registry, policyId, and owner).
   *
   * @param actualConfig - The on-chain router configuration.
   * @param expectedPredicateConfig - The expected predicate wrapper configuration.
   * @returns True if wrapper is deployed with all fields matching, false otherwise.
   */
  async isPredicateWrapperDeployed(
    actualConfig: DerivedTokenRouterConfig,
    expectedPredicateConfig: {
      predicateRegistry: string;
      policyId: string;
      owner: string;
    },
  ): Promise<boolean> {
    const found = await this.findDeployedPredicateWrapper(
      actualConfig,
      expectedPredicateConfig,
    );
    return (
      found !== undefined &&
      eqAddress(found.onchainOwner, expectedPredicateConfig.owner)
    );
  }

  /**
   * Create transactions to deploy predicate wrapper and update hook.
   *
   * @param actualConfig - The on-chain router configuration.
   * @param expectedConfig - The expected token router configuration.
   * @returns transactions to execute and whether a new wrapper is being deployed.
   *   deploysNewWrapper=true means the predicate emits its own setHook(aggregation)
   *   that supersedes any hook update in the same batch.
   */
  async createPredicateWrapperUpdateTxs(
    actualConfig: DerivedTokenRouterConfig,
    expectedConfig: HypTokenRouterConfig,
    pendingHookAddress?: Address,
  ): Promise<{
    transactions: AnnotatedEV5Transaction[];
    deploysNewWrapper: boolean;
  }> {
    // Only proceed if expectedConfig has predicateWrapper
    if (
      !('predicateWrapper' in expectedConfig) ||
      !expectedConfig.predicateWrapper
    ) {
      return { transactions: [], deploysNewWrapper: false };
    }

    const predicateWrapperConfig: PredicateWrapperConfig =
      PredicateWrapperConfigSchema.parse(expectedConfig.predicateWrapper);

    // Check if a wrapper matching by registry+policyId already exists on-chain.
    // If so, only a transferOwnership tx is needed (not a full redeploy).
    const existingWrapper = await this.findDeployedPredicateWrapper(
      actualConfig,
      predicateWrapperConfig,
    );

    if (existingWrapper) {
      if (
        eqAddress(existingWrapper.onchainOwner, predicateWrapperConfig.owner)
      ) {
        this.logger.debug(
          { chain: this.chainName },
          'Predicate wrapper already deployed with matching config, skipping',
        );
        return { transactions: [], deploysNewWrapper: false };
      }

      // Owner changed — generate a transferOwnership tx without redeploying.
      this.logger.debug(
        { chain: this.chainName, wrapper: existingWrapper.address },
        'Predicate wrapper owner changed, generating transferOwnership transaction',
      );
      const transferOwnershipTx = await PredicateRouterWrapper__factory.connect(
        existingWrapper.address,
        this.multiProvider.getProvider(this.chainName),
      ).populateTransaction.transferOwnership(predicateWrapperConfig.owner);
      return {
        transactions: [
          {
            ...transferOwnershipTx,
            chainId: this.chainId,
            annotation: `Transferring predicate wrapper ownership to ${predicateWrapperConfig.owner}`,
          },
        ],
        deploysNewWrapper: false,
      };
    }

    const staticAggregationHookFactory =
      this.args.addresses.staticAggregationHookFactory;
    if (!staticAggregationHookFactory) {
      throw new Error(
        `staticAggregationHookFactory not found for ${this.chainName}. Ensure proxy factories are deployed.`,
      );
    }

    const signer = this.multiProvider.getSigner(this.chainName);
    const factory = StaticAggregationHookFactory__factory.connect(
      staticAggregationHookFactory,
      signer,
    );

    const predicateDeployer = new PredicateWrapperDeployer(
      this.multiProvider,
      factory,
      this.logger,
    );

    // Deploy predicate wrapper and get addresses.
    // Pass token type to deploy the appropriate wrapper.
    // Pass pendingHookAddress (if any) so deployAndConfigure uses the post-update hook
    // instead of reading the stale on-chain value when hook and predicate wrapper are
    // both being changed in the same update() call.
    const result = await predicateDeployer.deployAndConfigure(
      this.chainName,
      this.args.addresses.deployedTokenRoute,
      predicateWrapperConfig,
      expectedConfig.type,
      pendingHookAddress,
    );

    this.logger.info(
      {
        chain: this.chainName,
        wrapper: result.wrapperAddress,
        aggregationHook: result.aggregationHookAddress,
      },
      'Predicate wrapper deployed, returning setHook transaction',
    );

    return {
      transactions: [
        {
          annotation:
            'Set aggregation hook wrapping PredicateRouterWrapper on warp route',
          chainId: this.chainId,
          ...result.setHookTx,
        },
      ],
      deploysNewWrapper: true,
    };
  }

  /**
   * Create transactions to update token fee configuration.
   *
   * @param actualConfig - The on-chain router configuration.
   * @param expectedConfig - The expected token router configuration.
   * @returns Ethereum transactions that need to be executed to update the token fee.
   */
  async createTokenFeeUpdateTxs(
    actualConfig: DerivedTokenRouterConfig,
    expectedConfig: HypTokenRouterConfig,
    tokenReaderParams?: Partial<TokenFeeReaderParams>,
  ): Promise<AnnotatedEV5Transaction[]> {
    if (!expectedConfig.tokenFee) {
      return [];
    }

    const routerAddress = this.args.addresses.deployedTokenRoute;
    const resolvedTokenFee = resolveTokenFeeAddress(
      expectedConfig.tokenFee,
      routerAddress,
      expectedConfig,
    );

    const currentTokenFee = actualConfig.tokenFee;

    if (!currentTokenFee) {
      this.logger.info('No existing token fee found, creating new one');

      const expandedExpectedConfig = await EvmTokenFeeModule.expandConfig({
        config: resolvedTokenFee,
        multiProvider: this.multiProvider,
        chainName: this.chainName,
      });

      const tokenFeeModule = await EvmTokenFeeModule.create({
        multiProvider: this.multiProvider,
        chain: this.chainName,
        config: expandedExpectedConfig,
        contractVerifier: this.contractVerifier,
      });
      const { deployedFee } = tokenFeeModule.serialize();

      // Check if fee recipient is already set correctly on-chain
      const tokenRouter = TokenRouter__factory.connect(
        routerAddress,
        this.multiProvider.getProvider(this.chainId),
      );
      const currentFeeRecipient = await tokenRouter
        .feeRecipient()
        .catch((error) => {
          this.logger.warn(
            `Failed to read feeRecipient, defaulting to generate setFeeRecipient tx`,
            error,
          );
          return constants.AddressZero;
        });

      if (eqAddress(currentFeeRecipient, deployedFee)) {
        return [];
      }

      return [
        {
          annotation: 'Setting new routing fee...',
          chainId: this.chainId,
          to: this.args.addresses.deployedTokenRoute,
          data: TokenRouter__factory.createInterface().encodeFunctionData(
            'setFeeRecipient(address)',
            [deployedFee],
          ),
        },
      ];
    }

    this.logger.info('Updating existing token fee configuration');

    const tokenFeeModule = new EvmTokenFeeModule(
      this.multiProvider,
      {
        chain: this.chainName,
        config: currentTokenFee,
        addresses: {
          deployedFee: currentTokenFee.address,
        },
      },
      this.contractVerifier,
    );
    const updateTransactions = await tokenFeeModule.update(
      resolvedTokenFee,
      tokenReaderParams,
    );
    const { deployedFee } = tokenFeeModule.serialize();

    // Only call setFeeRecipient if the fee recipient address has changed
    if (!eqAddress(currentTokenFee.address, deployedFee)) {
      updateTransactions.push({
        annotation: 'Updating routing fee...',
        chainId: this.chainId,
        to: this.args.addresses.deployedTokenRoute,
        data: TokenRouter__factory.createInterface().encodeFunctionData(
          'setFeeRecipient(address)',
          [deployedFee],
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

    if (
      typeof expectedConfig.interchainSecurityModule === 'string' &&
      isZeroishAddress(expectedConfig.interchainSecurityModule)
    ) {
      return {
        deployedIsm: expectedConfig.interchainSecurityModule,
        updateTransactions: [],
      };
    }

    const ismModule = new EvmIsmModule(
      this.multiProvider,
      {
        chain: this.args.chain,
        config: actualConfig.interchainSecurityModule,
        addresses: {
          ...this.args.addresses,
          mailbox: actualConfig.mailbox,
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

    assert(
      expectedConfig.type !== TokenType.unknown,
      'Cannot upgrade warp route with unknown token type',
    );

    // This should be impossible since we try catch the call to `PACKAGE_VERSION`
    // in `EvmWarpRouteReader.fetchPackageVersion`
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

    // Scale values are immutables baked into the implementation bytecode.
    // Changing the effective scale during an upgrade would cause in-flight
    // messages to be decoded with incorrect scaling.
    assert(
      scalesEqual(actualConfig.scale, expectedConfig.scale),
      `Scale change detected during upgrade. ` +
        `Changing scale on an existing deployment may cause in-flight messages to be decoded incorrectly.`,
    );

    this.logger.info(
      `Upgrading Warp Route implementation on ${this.args.chain} from ${actualConfig.contractVersion} to ${expectedConfig.contractVersion}`,
    );

    const deployer = new HypERC20Deployer(this.multiProvider);
    const constructorArgs = await deployer.constructorArgs(
      this.chainName,
      expectedConfig,
    );
    const tokenType = expectedConfig.type as DeployableTokenType;
    const implementation = await deployer.deployContractWithName(
      this.chainName,
      tokenType,
      hypERC20contracts[tokenType],
      constructorArgs,
      undefined,
      false,
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

  createSetMaxFeePpmTxs(
    actualConfig: DerivedTokenRouterConfig,
    expectedConfig: HypTokenRouterConfig,
  ): AnnotatedEV5Transaction[] {
    if (
      !isCctpTokenConfig(expectedConfig) ||
      expectedConfig.cctpVersion !== 'V2' ||
      expectedConfig.maxFeeBps === undefined
    ) {
      return [];
    }

    const actualMaxFeeBps = isCctpTokenConfig(actualConfig)
      ? actualConfig.maxFeeBps
      : undefined;

    // When upgrading across the CCTP_PPM_STORAGE_VERSION boundary, the
    // pre-upgrade contract stores the fee in integer bps while the
    // post-upgrade contract expects ppm. The reader normalises to bps so the
    // values look equal, but the raw on-chain slot will be wrong after the
    // proxy upgrade. Always emit setMaxFeePpm in this case.
    const crossingPpmBoundary =
      actualConfig.contractVersion &&
      expectedConfig.contractVersion &&
      compareVersions(actualConfig.contractVersion, CCTP_PPM_STORAGE_VERSION) <
        0 &&
      compareVersions(
        expectedConfig.contractVersion,
        CCTP_PPM_STORAGE_VERSION,
      ) >= 0;

    if (!crossingPpmBoundary && actualMaxFeeBps === expectedConfig.maxFeeBps) {
      return [];
    }

    const maxFeePpm = Math.round(expectedConfig.maxFeeBps * 100);
    return [
      {
        chainId: this.chainId,
        annotation: `Setting maxFeePpm to ${maxFeePpm} on ${this.args.chain}`,
        to: this.args.addresses.deployedTokenRoute,
        data: TokenBridgeCctpV2__factory.createInterface().encodeFunctionData(
          'setMaxFeePpm',
          [maxFeePpm],
        ),
      },
    ];
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
  }): Promise<EvmWarpModule> {
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

    const warpModule = new EvmWarpModule(
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
        ); // @TODO Remove when EvmWarpModule.create can be used
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
      ); // @TODO Remove when EvmWarpModule.create can be used

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
      ); // @TODO Remove when EvmWarpModule.create can be used

      for (const tx of addBridgesTxs) {
        await multiProvider.sendTransaction(chain, tx);
      }
    }

    if (isEverclearTokenBridgeConfig(config)) {
      const addRemoteOutputTokens = warpModule.createAddRemoteOutputAssetsTxs(
        actualConfig,
        config,
      );

      const updateEverclearFeeParamsTxs =
        warpModule.createUpdateEverclearFeeParamsTxs(actualConfig, config);

      const everclearTxs = [
        ...addRemoteOutputTokens,
        ...updateEverclearFeeParamsTxs,
      ];

      for (const tx of everclearTxs) {
        await multiProvider.sendTransaction(chain, tx);
      }
    }

    if (
      isCrossCollateralTokenConfig(config) &&
      config.crossCollateralRouters &&
      Object.keys(config.crossCollateralRouters).length > 0
    ) {
      const enrollTxs = warpModule.createEnrollCrossCollateralRoutersTxs(
        actualConfig,
        config,
      );

      for (const tx of enrollTxs) {
        await multiProvider.sendTransaction(chain, tx);
      }
    }

    return warpModule;
  }
}
