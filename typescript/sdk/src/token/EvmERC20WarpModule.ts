// import { expect } from 'chai';
import { BigNumberish } from 'ethers';
import { UINT_256_MAX } from 'starknet';

import {
  EverclearTokenBridge__factory,
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
  ZERO_ADDRESS_HEX_32,
  addressToBytes32,
  assert,
  deepEquals,
  difference,
  eqAddress,
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
import { shouldUpgrade } from '../contractversion.js';
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
import { EvmIsmModule } from '../ism/EvmIsmModule.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { AnnotatedEV5Transaction } from '../providers/ProviderType.js';
import { RemoteRouters, resolveRouterMapConfig } from '../router/types.js';
import { ChainName, ChainNameOrId } from '../types.js';
import { extractIsmAndHookFactoryAddresses } from '../utils/ism.js';

import { EvmERC20WarpRouteReader } from './EvmERC20WarpRouteReader.js';
import { hypERC20contracts } from './contracts.js';
import { HypERC20Deployer } from './deploy.js';
import {
  DerivedTokenRouterConfig,
  EverclearCollateralTokenConfig,
  HypTokenRouterConfig,
  HypTokenRouterConfigSchema,
  MovableTokenConfig,
  derivedIsmAddress,
  isEverclearTokenBridgeConfig,
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
    tokenReaderParams?: Partial<TokenFeeReaderParams>,
  ): Promise<AnnotatedEV5Transaction[]> {
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
      ...(await this.upgradeWarpRouteImplementationTx(
        actualConfig,
        expectedConfig,
      )),
      ...(await this.createIsmUpdateTxs(actualConfig, expectedConfig)),
      ...(await this.createHookUpdateTxs(actualConfig, expectedConfig)),
      ...(await this.createTokenFeeUpdateTxs(
        actualConfig,
        expectedConfig,
        tokenReaderParams,
      )),
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

      ...this.createAddRemoteOutputAssetsTxs(actualConfig, expectedConfig),
      ...this.createRemoveRemoteOutputAssetsTxs(actualConfig, expectedConfig),

      ...this.createUpdateEverclearFeeParamsTxs(actualConfig, expectedConfig),
      ...this.createRemoveEverclearFeeParamsTxs(actualConfig, expectedConfig),

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
    if (!expectedConfig.hook) {
      return [];
    }

    const proxyAdminAddress =
      expectedConfig.proxyAdmin?.address ?? actualConfig.proxyAdmin?.address;
    assert(proxyAdminAddress, 'ProxyAdmin address is undefined');

    return getEvmHookUpdateTransactions(
      this.args.addresses.deployedTokenRoute,
      {
        actualConfig: actualConfig.hook,
        expectedConfig: expectedConfig.hook,
        ccipContractCache: this.ccipContractCache,
        contractVerifier: this.contractVerifier,
        evmChainName: this.chainName,
        hookAndIsmFactories: extractIsmAndHookFactoryAddresses(
          this.args.addresses,
        ),
        setHookFunctionCallEncoder: (newHookAddress: string) =>
          MailboxClient__factory.createInterface().encodeFunctionData(
            'setHook',
            [newHookAddress],
          ),
        logger: this.logger,
        mailbox: actualConfig.mailbox,
        multiProvider: this.multiProvider,
        proxyAdminAddress,
      },
    );
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
    // If no token fee is expected, return empty array
    if (!expectedConfig.tokenFee) {
      return [];
    }

    // Get the current token fee configuration from the actual config
    const currentTokenFee = actualConfig.tokenFee;

    // If there's no current token fee but we expect one, we need to deploy
    if (!currentTokenFee) {
      this.logger.info('No existing token fee found, creating new one');

      // First expand the input config to a full config
      const expandedExpectedConfig = await EvmTokenFeeModule.expandConfig({
        config: expectedConfig.tokenFee,
        multiProvider: this.multiProvider,
        chainName: this.chainName,
      });

      // Create a new EvmTokenFeeModule to deploy the token fee
      const tokenFeeModule = await EvmTokenFeeModule.create({
        multiProvider: this.multiProvider,
        chain: this.chainName,
        config: expandedExpectedConfig,
        contractVerifier: this.contractVerifier,
      });
      const { deployedFee } = tokenFeeModule.serialize();

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

    // If there's an existing token fee, update it
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
      expectedConfig.tokenFee,
      tokenReaderParams,
    );
    const { deployedFee } = tokenFeeModule.serialize();
    updateTransactions.push({
      annotation: 'Updating routing fee...',
      chainId: this.chainId,
      to: this.args.addresses.deployedTokenRoute,
      data: TokenRouter__factory.createInterface().encodeFunctionData(
        'setFeeRecipient(address)',
        [deployedFee],
      ),
    });
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

    if (!shouldUpgrade(actualConfig, expectedConfig)) {
      return [];
    }

    this.logger.info(
      `Upgrading Warp Route implementation on ${this.args.chain} from ${actualConfig.contractVersion} to ${expectedConfig.contractVersion}`,
    );

    const deployer = new HypERC20Deployer(this.multiProvider);
    const constructorArgs = await deployer.constructorArgs(
      this.chainName,
      expectedConfig,
    );
    const implementation = await deployer.deployContractWithName(
      this.chainName,
      expectedConfig.type,
      hypERC20contracts[expectedConfig.type],
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

    return warpModule;
  }
}
