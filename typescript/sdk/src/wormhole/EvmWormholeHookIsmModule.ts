import {
  WormholeExecutorHookIsm__factory,
  WormholeVaaHookIsm__factory,
} from '@hyperlane-xyz/core';
import {
  Address,
  Domain,
  EvmChainId,
  ProtocolType,
  addressToBytes32,
  assert,
  deepEquals,
  eqAddress,
  rootLogger,
} from '@hyperlane-xyz/utils';
import { constants, Contract } from 'ethers';

import { transferOwnershipTransactions } from '../contracts/contracts.js';
import {
  HyperlaneModule,
  HyperlaneModuleParams,
} from '../core/AbstractHyperlaneModule.js';
import { ContractVerifier } from '../deploy/verify/ContractVerifier.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { AnnotatedEV5Transaction } from '../providers/ProviderType.js';
import { ChainMap, ChainName } from '../types.js';

import { EvmWormholeHookIsmReader } from './EvmWormholeHookIsmReader.js';
import {
  DerivedWormholeHookIsmConfig,
  WormholeHookIsmAddresses,
  WormholeHookIsmConfig,
  WormholeHookIsmSchema,
  WormholeMeshConfig,
  WormholeRemoteRouterConfig,
  WormholeVariant,
  findAsymmetricWormholeRoutes,
} from './types.js';
import {
  type WormholeConsistencyLevelConfig,
  WormholeConsistencyType,
  consistencyLevelForConfig,
} from './consistency.js';

function consistencyLevelConfigsEqual(
  current: WormholeConsistencyLevelConfig | undefined,
  target: WormholeConsistencyLevelConfig | undefined,
): boolean {
  if (!current || !target || current.type !== target.type) return false;
  if (
    current.type !== WormholeConsistencyType.Custom ||
    target.type !== WormholeConsistencyType.Custom
  ) {
    return true;
  }
  return (
    eqAddress(current.address, target.address) &&
    current.baseConsistencyLevel === target.baseConsistencyLevel &&
    current.additionalBlocks === target.additionalBlocks
  );
}

export interface WormholeMeshReconciliation {
  addresses: ChainMap<Address>;
  /** Owner-authorized updates for routers that were reused. */
  transactions: ChainMap<AnnotatedEV5Transaction[]>;
}

/** Values fixed at construction; changing one requires a fresh deployment. */
const IMMUTABLE_FIELDS = [
  'type',
  'mailbox',
  'core',
  'wormholeChainId',
  'executorQuoterRouter',
] as const;

/**
 * Deploys and maintains the combined Wormhole hook/ISM router.
 *
 * A dedicated module exists because the generic hook and ISM deployers would
 * each deploy their own contract, breaking the invariant that one address serves
 * as both roles. Mesh enrollment is a static, two-phase operation: every chain's
 * router must exist before any of them can enroll the others.
 */
export class EvmWormholeHookIsmModule extends HyperlaneModule<
  ProtocolType.Ethereum,
  WormholeHookIsmConfig,
  WormholeHookIsmAddresses
> {
  static protocols = [ProtocolType.Ethereum];
  protected readonly logger = rootLogger.child({
    module: 'EvmWormholeHookIsmModule',
  });
  protected readonly reader: EvmWormholeHookIsmReader;

  public readonly chain: ChainName;
  public readonly chainId: EvmChainId;
  public readonly domainId: Domain;

  constructor(
    protected readonly multiProvider: MultiProvider,
    params: HyperlaneModuleParams<
      WormholeHookIsmConfig,
      WormholeHookIsmAddresses
    >,
    protected readonly contractVerifier?: ContractVerifier,
  ) {
    params.config = WormholeHookIsmSchema.parse(params.config);
    super(params);

    this.reader = new EvmWormholeHookIsmReader(multiProvider, params.chain);
    this.chain = multiProvider.getChainName(this.args.chain);
    this.chainId = multiProvider.getEvmChainId(this.chain);
    this.domainId = multiProvider.getDomainId(this.chain);
  }

  public async read(): Promise<DerivedWormholeHookIsmConfig> {
    return this.reader.deriveWormholeConfig(this.args.addresses.deployedRouter);
  }

  /**
   * Returns the transactions that move the deployed router to `targetConfig`.
   * Re-running against an already-matching deployment returns no transactions.
   */
  public async update(
    targetConfig: WormholeHookIsmConfig,
  ): Promise<AnnotatedEV5Transaction[]> {
    const target = WormholeHookIsmSchema.parse(targetConfig);
    const current = await this.read();

    this.assertImmutablesUnchanged(current, target);

    const transactions: AnnotatedEV5Transaction[] = [
      ...this.enrollmentTransactions(current, target),
      ...this.urlTransactions(current, target),
    ];

    // Ownership moves last so the deployer can still apply the changes above.
    transactions.push(
      ...transferOwnershipTransactions(
        this.chainId,
        this.args.addresses.deployedRouter,
        current,
        target,
        `Wormhole hook/ISM on ${this.chain}`,
      ),
    );

    this.args.config = target;
    return transactions;
  }

  private assertImmutablesUnchanged(
    current: DerivedWormholeHookIsmConfig,
    target: WormholeHookIsmConfig,
  ): void {
    assert(
      consistencyLevelConfigsEqual(
        current.consistencyLevel,
        target.consistencyLevel,
      ),
      `Wormhole hook/ISM on ${this.chain} has immutable consistencyLevel ${JSON.stringify(
        current.consistencyLevel,
      )}; target wants ${JSON.stringify(target.consistencyLevel)}. Deploy a new router instead.`,
    );
    for (const field of IMMUTABLE_FIELDS) {
      const currentValue = current[field];
      const targetValue = target[field];
      if (field === 'wormholeChainId' && targetValue === undefined) continue;
      if (currentValue === undefined && targetValue === undefined) continue;

      const equal =
        typeof currentValue === 'string' && typeof targetValue === 'string'
          ? eqAddress(currentValue, targetValue) || currentValue === targetValue
          : currentValue === targetValue;

      assert(
        equal,
        `Wormhole hook/ISM on ${this.chain} has immutable ${field} ${String(
          currentValue,
        )}; target wants ${String(targetValue)}. Deploy a new router instead.`,
      );
    }
  }

  private enrollmentTransactions(
    current: DerivedWormholeHookIsmConfig,
    target: WormholeHookIsmConfig,
  ): AnnotatedEV5Transaction[] {
    const transactions: AnnotatedEV5Transaction[] = [];

    const toUnenroll = Object.keys(current.remoteRouters).filter(
      (chain) => !target.remoteRouters[chain],
    );
    const toEnroll = Object.entries(target.remoteRouters).filter(
      ([chain, remote]) =>
        !this.remoteRouterMatches(current.remoteRouters[chain], remote),
    );

    // Unenroll first: a Wormhole chain-ID change is never folded into an
    // address replacement on chain, so the old entry must go before the new one.
    for (const chain of toUnenroll) {
      transactions.push({
        chainId: this.chainId,
        annotation: `Unenrolling ${chain} from the Wormhole hook/ISM on ${this.chain}`,
        to: this.args.addresses.deployedRouter,
        data: WormholeVaaHookIsm__factory.createInterface().encodeFunctionData(
          'unenrollRemoteRouter',
          [this.multiProvider.getDomainId(chain)],
        ),
      });
    }

    for (const [chain, remote] of toEnroll) {
      const existing = current.remoteRouters[chain];
      if (existing && existing.wormholeChainId !== remote.wormholeChainId) {
        transactions.push({
          chainId: this.chainId,
          annotation: `Unenrolling ${chain} from the Wormhole hook/ISM on ${this.chain} before its Wormhole chain ID changes`,
          to: this.args.addresses.deployedRouter,
          data: WormholeVaaHookIsm__factory.createInterface().encodeFunctionData(
            'unenrollRemoteRouter',
            [this.multiProvider.getDomainId(chain)],
          ),
        });
      }
    }

    if (toEnroll.length > 0) {
      transactions.push({
        chainId: this.chainId,
        annotation: `Enrolling ${toEnroll
          .map(([chain]) => chain)
          .join(', ')} on the Wormhole hook/ISM on ${this.chain}`,
        to: this.args.addresses.deployedRouter,
        data: this.encodeBatchEnrollment(
          target.type,
          toEnroll.map(([chain, remote]) => [chain, remote]),
        ),
      });
    }

    return transactions;
  }

  private urlTransactions(
    current: DerivedWormholeHookIsmConfig,
    target: WormholeHookIsmConfig,
  ): AnnotatedEV5Transaction[] {
    if (target.type !== WormholeVariant.DirectVaa || !target.urls) return [];
    if (deepEquals(current.urls ?? [], target.urls)) return [];

    return [
      {
        chainId: this.chainId,
        annotation: `Updating CCIP-read URLs on the Wormhole hook/ISM on ${this.chain}`,
        to: this.args.addresses.deployedRouter,
        data: WormholeVaaHookIsm__factory.createInterface().encodeFunctionData(
          'setUrls',
          [target.urls],
        ),
      },
    ];
  }

  private remoteRouterMatches(
    current: WormholeRemoteRouterConfig | undefined,
    target: WormholeRemoteRouterConfig,
  ): boolean {
    if (!current) return false;
    if (!eqAddress(current.router, target.router)) return false;
    if (current.wormholeChainId !== target.wormholeChainId) return false;
    if (current.expectedConsistencyLevel !== target.expectedConsistencyLevel) {
      return false;
    }

    if (target.quoter !== undefined) {
      if (!current.quoter || !eqAddress(current.quoter, target.quoter)) {
        return false;
      }
    }
    if (target.callbackGasLimit !== undefined) {
      if (
        current.callbackGasLimit === undefined ||
        BigInt(current.callbackGasLimit) !== BigInt(target.callbackGasLimit)
      ) {
        return false;
      }
    }

    return true;
  }

  private encodeBatchEnrollment(
    variant: WormholeVariant,
    routes: Array<[ChainName, WormholeRemoteRouterConfig]>,
  ): string {
    const enrollments = routes.map(([chain, remote]) => ({
      domain: this.multiProvider.getDomainId(chain),
      router: addressToBytes32(remote.router),
      wormholeChainId: remote.wormholeChainId,
      expectedConsistencyLevel: remote.expectedConsistencyLevel,
    }));

    if (variant === WormholeVariant.DirectVaa) {
      return WormholeVaaHookIsm__factory.createInterface().encodeFunctionData(
        'enrollRemoteRouters((uint32,bytes32,uint16,uint8)[])',
        [enrollments],
      );
    }

    return WormholeExecutorHookIsm__factory.createInterface().encodeFunctionData(
      'enrollRemoteRouters(((uint32,bytes32,uint16,uint8),address,uint128)[])',
      [
        routes.map(([, remote], index) => {
          assert(
            remote.quoter && remote.callbackGasLimit !== undefined,
            'wormholeExecutor enrollment requires quoter and callbackGasLimit',
          );
          return {
            remoteRouter: enrollments[index],
            quoter: remote.quoter,
            callbackGasLimit: remote.callbackGasLimit.toString(),
          };
        }),
      ],
    );
  }

  // ============ Mesh orchestration ============

  /**
   * Deploys one router per chain, then enrolls the complete mesh.
   *
   * Two phases are required, not preferred: enrollment needs every remote
   * address, and none exist until every chain has been deployed. The mesh is
   * validated for symmetry before anything is broadcast.
   */
  public static async deployMesh(
    multiProvider: MultiProvider,
    mesh: WormholeMeshConfig,
    contractVerifier?: ContractVerifier,
  ): Promise<ChainMap<Address>> {
    const result = await EvmWormholeHookIsmModule.reconcileMesh(
      multiProvider,
      mesh,
      {},
      contractVerifier,
    );
    assert(
      Object.values(result.transactions).every((txs) => txs.length === 0),
      'Fresh Wormhole mesh unexpectedly returned deferred transactions',
    );
    return result.addresses;
  }

  /**
   * Reuses compatible routers, deploys missing/replacement routers, resolves
   * the complete mesh, and returns updates requiring the reused routers'
   * existing owners. Fresh routers are configured immediately while the
   * deployer still owns them, then ownership is transferred last.
   */
  public static async reconcileMesh(
    multiProvider: MultiProvider,
    mesh: WormholeMeshConfig,
    existingAddresses: ChainMap<Address> = {},
    contractVerifier?: ContractVerifier,
  ): Promise<WormholeMeshReconciliation> {
    const logger = rootLogger.child({ module: 'EvmWormholeHookIsmModule' });
    const chains = Object.keys(mesh);
    assert(chains.length > 1, 'A Wormhole mesh needs at least two chains');

    for (const chain of chains) {
      assert(
        multiProvider.getProtocol(chain) === ProtocolType.Ethereum,
        `Wormhole hook/ISM only supports EVM chains; ${chain} is not one`,
      );
      WormholeHookIsmSchema.parse(mesh[chain]);
      if (mesh[chain].wormholeChainId !== undefined) {
        const core = new Contract(
          mesh[chain].core,
          ['function chainId() view returns (uint16)'],
          multiProvider.getProvider(chain),
        );
        const actualChainId = Number(await core.chainId());
        assert(
          actualChainId === mesh[chain].wormholeChainId,
          `Wormhole Core on ${chain} reports chain ID ${actualChainId}; config expects ${mesh[chain].wormholeChainId}`,
        );
      }
    }

    const addresses: ChainMap<Address> = {};
    const fresh = new Set<ChainName>();
    for (const chain of chains) {
      const existing = existingAddresses[chain];
      if (existing) {
        const current = await new EvmWormholeHookIsmReader(
          multiProvider,
          chain,
        ).deriveWormholeConfig(existing);
        if (!EvmWormholeHookIsmModule.requiresRedeploy(current, mesh[chain])) {
          addresses[chain] = existing;
          continue;
        }
        logger.info(
          { chain, existing },
          'Replacing Wormhole hook/ISM because an immutable changed',
        );
      }

      addresses[chain] = await EvmWormholeHookIsmModule.deployRouter(
        multiProvider,
        chain,
        mesh[chain],
        contractVerifier,
      );
      fresh.add(chain);
      logger.info(
        { chain, address: addresses[chain] },
        'Deployed Wormhole hook/ISM router',
      );
    }

    const resolved = EvmWormholeHookIsmModule.withDeployedRouters(
      mesh,
      addresses,
    );
    const problems = findAsymmetricWormholeRoutes(resolved);
    assert(
      problems.length === 0,
      `Asymmetric Wormhole mesh:\n  ${problems.join('\n  ')}`,
    );

    const deferred: ChainMap<AnnotatedEV5Transaction[]> = {};
    for (const chain of chains) {
      const module = new EvmWormholeHookIsmModule(multiProvider, {
        chain,
        config: resolved[chain],
        addresses: {
          deployedRouter: addresses[chain],
          mailbox: resolved[chain].mailbox,
        },
      });
      const transactions = await module.update(resolved[chain]);
      if (fresh.has(chain)) {
        for (const transaction of transactions) {
          await multiProvider.sendTransaction(chain, transaction);
        }
      } else {
        deferred[chain] = transactions;
      }
      logger.info(
        {
          chain,
          transactions: transactions.length,
          deferred: !fresh.has(chain),
        },
        'Reconciled Wormhole hook/ISM router',
      );
    }

    return { addresses, transactions: deferred };
  }

  private static requiresRedeploy(
    current: DerivedWormholeHookIsmConfig,
    target: WormholeHookIsmConfig,
  ): boolean {
    if (
      !consistencyLevelConfigsEqual(
        current.consistencyLevel,
        target.consistencyLevel,
      )
    ) {
      return true;
    }
    return IMMUTABLE_FIELDS.some((field) => {
      const currentValue = current[field];
      const targetValue = target[field];
      if (field === 'wormholeChainId' && targetValue === undefined)
        return false;
      if (currentValue === undefined && targetValue === undefined) return false;
      if (typeof currentValue === 'string' && typeof targetValue === 'string') {
        return (
          !eqAddress(currentValue, targetValue) && currentValue !== targetValue
        );
      }
      return currentValue !== targetValue;
    });
  }

  /**
   * Replaces every `remoteRouters[*].router` with the freshly deployed address
   * for that chain, leaving the rest of the mesh config untouched.
   */
  public static withDeployedRouters(
    mesh: WormholeMeshConfig,
    addresses: ChainMap<Address>,
  ): WormholeMeshConfig {
    return Object.fromEntries(
      Object.entries(mesh).map(([chain, config]) => [
        chain,
        {
          ...config,
          remoteRouters: Object.fromEntries(
            Object.entries(config.remoteRouters).map(([remote, route]) => {
              const deployed = addresses[remote];
              assert(
                deployed,
                `No deployed Wormhole router for ${remote}, enrolled by ${chain}`,
              );
              return [remote, { ...route, router: deployed }];
            }),
          ),
        },
      ]),
    );
  }

  public static async readMesh(
    multiProvider: MultiProvider,
    addresses: ChainMap<Address>,
  ): Promise<ChainMap<DerivedWormholeHookIsmConfig>> {
    const entries = await Promise.all(
      Object.entries(addresses).map(async ([chain, address]) => [
        chain,
        await new EvmWormholeHookIsmReader(
          multiProvider,
          chain,
        ).deriveWormholeConfig(address),
      ]),
    );
    return Object.fromEntries(entries);
  }

  private static async deployRouter(
    multiProvider: MultiProvider,
    chain: ChainName,
    config: WormholeHookIsmConfig,
    contractVerifier?: ContractVerifier,
  ): Promise<Address> {
    const signer = multiProvider.getSigner(chain);
    const custom =
      config.consistencyLevel.type === WormholeConsistencyType.Custom
        ? config.consistencyLevel
        : undefined;
    const consistencyLevelConfig = {
      consistencyLevel: consistencyLevelForConfig(config.consistencyLevel),
      customConsistencyLevel: custom?.address ?? constants.AddressZero,
      baseConsistencyLevel: custom
        ? consistencyLevelForConfig({ type: custom.baseConsistencyLevel })
        : 0,
      additionalBlocks: custom?.additionalBlocks ?? 0,
    };

    if (config.type === WormholeVariant.Executor) {
      assert(
        config.executorQuoterRouter,
        `wormholeExecutor on ${chain} requires executorQuoterRouter`,
      );
      const router = await new WormholeExecutorHookIsm__factory(signer).deploy(
        config.mailbox,
        config.core,
        consistencyLevelConfig,
        config.executorQuoterRouter,
        multiProvider.getTransactionOverrides(chain),
      );
      await multiProvider.handleTx(chain, router.deployTransaction);
      await contractVerifier?.verifyContract(chain, {
        name: 'WormholeExecutorHookIsm',
        address: router.address,
        constructorArguments: WormholeExecutorHookIsm__factory.createInterface()
          .encodeDeploy([
            config.mailbox,
            config.core,
            consistencyLevelConfig,
            config.executorQuoterRouter,
          ])
          .replace('0x', ''),
        isProxy: false,
      });
      return router.address;
    }

    assert(config.urls, `wormholeVaa on ${chain} requires urls`);
    const router = await new WormholeVaaHookIsm__factory(signer).deploy(
      config.mailbox,
      config.core,
      consistencyLevelConfig,
      config.urls,
      multiProvider.getTransactionOverrides(chain),
    );
    await multiProvider.handleTx(chain, router.deployTransaction);
    await contractVerifier?.verifyContract(chain, {
      name: 'WormholeVaaHookIsm',
      address: router.address,
      constructorArguments: WormholeVaaHookIsm__factory.createInterface()
        .encodeDeploy([
          config.mailbox,
          config.core,
          consistencyLevelConfig,
          config.urls,
        ])
        .replace('0x', ''),
      isProxy: false,
    });
    return router.address;
  }
}
