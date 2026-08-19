import { ethers } from 'ethers';
import { Logger } from 'pino';

import {
  AbstractCcipReadIsm__factory,
  AmountRoutingIsm__factory,
  BlacklistIsm__factory,
  DefaultIsm__factory,
  DelayedFlowRouterHookIsm__factory,
  DomainRoutingIsm__factory,
  PausableIsm__factory,
  RateLimitedIsm__factory,
  StaticAggregationIsm__factory,
} from '@hyperlane-xyz/core';
import {
  Address,
  Domain,
  EvmChainId,
  ProtocolType,
  arrayEqual,
  assert,
  deepEquals,
  eqAddress,
  intersection,
  isZeroishAddress,
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
import { ContractVerifier } from '../deploy/verify/ContractVerifier.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { AnnotatedEV5Transaction } from '../providers/ProviderType.js';
import { ChainName, ChainNameOrId } from '../types.js';
import { throwIfNotMissingSelector } from '../utils/contract.js';
import {
  canonicalizeRemoteIsms,
  collapseMatchingHybridIsmNodes,
  normalizeConfig,
  resolveHybridIsmNodesToAddress,
} from '../utils/ism.js';

import { EvmIsmReader } from './EvmIsmReader.js';
import { HyperlaneIsmFactory } from './HyperlaneIsmFactory.js';
import {
  BaseIsmConfigSchema,
  BlacklistIsmConfig,
  DelayedFlowRouterHookIsmConfig,
  DeployedIsm,
  DomainRoutingIsmConfig,
  IsmConfig,
  IsmConfigSchema,
  IsmType,
  MUTABLE_ISM_TYPE,
  NetFlowRateLimitedHookIsmConfig,
  OffchainLookupIsmConfig,
  PausableIsmConfig,
  RateLimitedIsmConfig,
} from './types.js';
import { calculateDomainRoutingDelta } from './utils.js';

// Computes the case-insensitive difference between the current and target
// blacklisted ID sets. `extras` are on-chain IDs missing from the target;
// since the contract is append-only, non-empty `extras` means the target
// config can only be reached by redeploying a fresh ISM.
function calculateBlacklistDelta(
  current: readonly string[],
  target: readonly string[],
): { toAdd: string[]; extras: string[] } {
  const currentIds = new Set(current.map((id) => id.toLowerCase()));
  const targetIds = new Set(target.map((id) => id.toLowerCase()));

  return {
    toAdd: [...targetIds].filter((id) => !currentIds.has(id)),
    extras: [...currentIds].filter((id) => !targetIds.has(id)),
  };
}

// Every ISM config type that carries sub-modules, i.e. the ones whose
// composition the ISM config schema validates (aggregation exhaustiveness,
// mandatory positions). Listed by config shape rather than by what the EVM
// path happens to support, so the guard below does not depend on a second
// invariant to stay complete.
const COMPOSED_ISM_TYPES: ReadonlySet<IsmType> = new Set<IsmType>([
  IsmType.AGGREGATION,
  IsmType.STORAGE_AGGREGATION,
  IsmType.ROUTING,
  IsmType.FALLBACK_ROUTING,
  IsmType.INCREMENTAL_ROUTING,
  IsmType.AMOUNT_ROUTING,
  IsmType.INTERCHAIN_ACCOUNT_ROUTING,
  IsmType.COMPOSITE,
]);

type IsmModuleAddresses = {
  deployedIsm: Address;
  mailbox: Address;
};

type ContainerSubModuleEntry = { address: Address; targetConfig: IsmConfig };

export class EvmIsmModule extends HyperlaneModule<
  ProtocolType.Ethereum,
  IsmConfig,
  HyperlaneAddresses<ProxyFactoryFactories> & IsmModuleAddresses
> {
  static protocols = [ProtocolType.Ethereum, ProtocolType.Tron];
  protected readonly logger = rootLogger.child({ module: 'EvmIsmModule' });
  protected readonly reader: EvmIsmReader;
  protected readonly ismFactory: HyperlaneIsmFactory;
  protected readonly mailbox: Address;

  // Adding these to reduce how often we need to grab from MultiProvider.
  public readonly chain: ChainName;
  public readonly chainId: EvmChainId;
  public readonly domainId: Domain;

  constructor(
    protected readonly multiProvider: MultiProvider,
    params: HyperlaneModuleParams<
      IsmConfig,
      HyperlaneAddresses<ProxyFactoryFactories> & IsmModuleAddresses
    >,
    protected readonly ccipContractCache?: CCIPContractCache,
    protected readonly contractVerifier?: ContractVerifier,
  ) {
    params.config = BaseIsmConfigSchema.parse(params.config);
    super(params);

    this.reader = new EvmIsmReader(multiProvider, params.chain);

    this.ismFactory = HyperlaneIsmFactory.fromAddressesMap(
      { [params.chain]: params.addresses },
      multiProvider,
      ccipContractCache,
      contractVerifier,
    );

    this.mailbox = params.addresses.mailbox;

    this.chain = multiProvider.getChainName(this.args.chain);
    this.chainId = multiProvider.getEvmChainId(this.chain);
    this.domainId = multiProvider.getDomainId(this.chain);
  }

  public async read(): Promise<IsmConfig> {
    return typeof this.args.config === 'string'
      ? this.args.addresses.deployedIsm
      : this.reader.deriveIsmConfig(this.args.addresses.deployedIsm);
  }

  // whoever calls update() needs to ensure that targetConfig has a valid owner
  public async update(
    targetConfig: IsmConfig,
    opaqueHybridAddresses: Address[] = [],
  ): Promise<AnnotatedEV5Transaction[]> {
    const parsedTargetConfig = IsmConfigSchema.parse(targetConfig);
    return this.updateInternal(parsedTargetConfig, opaqueHybridAddresses);
  }

  /**
   * Reconciles a single already-deployed ISM instance, skipping the
   * route-level composition rules that `update()` enforces.
   *
   * Composition (e.g. "a hybrid hook/ISM must sit in a mandatory aggregation
   * beside an authenticating ISM") is a property of the tree installed on a
   * router, and is validated where that tree is expressed — the warp/core
   * config schemas and the deploy-time guards. This entry point does not
   * install anything on a router; it emits transactions against an instance
   * that already passed those checks (cross-chain enrollment of a
   * DelayedFlowRouterHookIsm being the motivating case), so applying the
   * composition rules to the bare node here would reject a legitimate
   * operation.
   *
   * Restricted to a single leaf node so the escape hatch cannot express a
   * composed tree at all: anything that aggregates or routes must go through
   * `update()`, where the composition rules run.
   */
  public async updateDeployedInstance(
    targetConfig: IsmConfig,
  ): Promise<AnnotatedEV5Transaction[]> {
    assert(
      typeof targetConfig !== 'string',
      `updateDeployedInstance on ${this.chain} reconciles a single deployed instance and needs its config, not a bare address — use update() for an address target`,
    );
    assert(
      !COMPOSED_ISM_TYPES.has(targetConfig.type),
      `updateDeployedInstance on ${this.chain} got a composed '${targetConfig.type}' config; composed trees must go through update(), which enforces the composition rules`,
    );
    return this.updateInternal(targetConfig);
  }

  private async updateInternal(
    targetConfig: IsmConfig,
    opaqueHybridAddresses: Address[] = [],
  ): Promise<AnnotatedEV5Transaction[]> {
    const parsedTargetConfig = BaseIsmConfigSchema.parse(targetConfig);

    // Nothing to do if its the default ism
    if (
      typeof parsedTargetConfig === 'string' &&
      isZeroishAddress(parsedTargetConfig)
    ) {
      return [];
    }

    // We need to normalize the current and target configs to compare.
    let normalizedTargetConfig: IsmConfig = normalizeConfig(
      await this.reader.deriveIsmConfig(parsedTargetConfig),
    );
    for (const address of opaqueHybridAddresses) {
      normalizedTargetConfig = resolveHybridIsmNodesToAddress(
        normalizedTargetConfig,
        address,
      );
    }
    normalizedTargetConfig = normalizeConfig(normalizedTargetConfig);
    let currentConfig = await this.read();
    for (const address of opaqueHybridAddresses) {
      currentConfig = collapseMatchingHybridIsmNodes(currentConfig, address);
    }
    const normalizedCurrentConfig: IsmConfig = normalizeConfig(currentConfig);

    // `remoteIsms` is an authoritative set when present. The reader cannot
    // name domains missing from the MultiProvider, so their enrollment is not
    // represented in normalizedCurrentConfig. Continue into the live-domain
    // reconciliation below even when the visible configs compare equal.
    const reconcileDelayedFlowEnrollments =
      typeof normalizedTargetConfig !== 'string' &&
      normalizedTargetConfig.type === IsmType.DELAYED_FLOW_ROUTER &&
      normalizedTargetConfig.remoteIsms !== undefined;

    // A MAILBOX_DEFAULT config is `{ type }` alone — the instance's mailbox is
    // an immutable constructor arg the reader omits, so an instance deferring
    // to a different mailbox compares equal to one deferring to this module's
    // and would be silently kept, routing through the wrong default ISM. Read
    // it on-chain instead. Same compensation the RATE_LIMITED `recipient` case
    // below makes for its own normalize-stripped immutable; the redeploy
    // itself falls out of MAILBOX_DEFAULT not being a mutable ISM type.
    const mailboxDefaultRebound =
      typeof normalizedCurrentConfig !== 'string' &&
      typeof normalizedTargetConfig !== 'string' &&
      normalizedCurrentConfig.type === IsmType.MAILBOX_DEFAULT &&
      normalizedTargetConfig.type === IsmType.MAILBOX_DEFAULT &&
      !eqAddress(
        await DefaultIsm__factory.connect(
          this.args.addresses.deployedIsm,
          this.multiProvider.getProvider(this.chain),
        ).mailbox(),
        this.mailbox,
      );

    // If configs match, no updates needed
    if (
      !mailboxDefaultRebound &&
      !reconcileDelayedFlowEnrollments &&
      deepEquals(normalizedCurrentConfig, normalizedTargetConfig)
    ) {
      return [];
    }

    // Update the module config to the target one as we are sure now that an update will be needed
    this.args.config = normalizedTargetConfig;

    // if the new config is an address just point the module to the new address
    if (typeof normalizedTargetConfig === 'string') {
      this.args.addresses.deployedIsm = normalizedTargetConfig;

      return [];
    }

    // Conditions for deploying a new ISM:
    // - If updating from an address/custom config to a proper ISM config.
    // - If updating a proper ISM config whose types are different.
    // - If it is not a mutable ISM.
    // Else, we have to figure out what an update for this ISM entails
    // Check if we need to deploy a new ISM
    //
    // Special case: RATE_LIMITED recipient and duration are immutable (set in
    // the constructor) — must redeploy a fresh ISM if either changes. duration
    // is available from read(), but recipient is omitted (immutable constructor
    // arg), so fetch it on-chain to compare.
    let rateLimitedImmutableChanged = false;
    if (
      typeof normalizedCurrentConfig !== 'string' &&
      normalizedCurrentConfig.type === IsmType.RATE_LIMITED &&
      normalizedTargetConfig.type === IsmType.RATE_LIMITED
    ) {
      const durationChanged =
        normalizedCurrentConfig.duration !== normalizedTargetConfig.duration;
      let recipientChanged = false;
      if (normalizedTargetConfig.recipient !== undefined) {
        const onChainRecipient = await RateLimitedIsm__factory.connect(
          this.args.addresses.deployedIsm,
          this.multiProvider.getProvider(this.chain),
        ).recipient();
        recipientChanged = !eqAddress(
          onChainRecipient,
          normalizedTargetConfig.recipient,
        );
      }
      rateLimitedImmutableChanged = durationChanged || recipientChanged;
    }

    // Special case: BLACKLIST entries are append-only — if the target config
    // drops any currently blacklisted ID, or the deployed ISM predates on-chain
    // enumeration, must redeploy a fresh ISM.
    const blacklistRequiresRedeploy =
      typeof normalizedCurrentConfig !== 'string' &&
      normalizedCurrentConfig.type === IsmType.BLACKLIST &&
      normalizedTargetConfig.type === IsmType.BLACKLIST &&
      !(await this.blacklistCanBeUpdatedInPlace(
        this.args.addresses.deployedIsm,
        normalizedCurrentConfig,
        normalizedTargetConfig,
      ));

    // Same principle for the warp-route hybrid hook/ISMs: their rate params
    // are constructor-set immutables, so any change forces a redeploy. All
    // fields are present in read(), so no extra on-chain fetch is needed.
    // warpRouter is optional on the target (implicit in warp-route context),
    // so it only counts as changed when explicitly provided — mirroring the
    // RATE_LIMITED recipient handling above.
    let hybridImmutableChanged = false;
    if (
      typeof normalizedCurrentConfig !== 'string' &&
      normalizedCurrentConfig.type === IsmType.NET_FLOW_RATE_LIMITED &&
      normalizedTargetConfig.type === IsmType.NET_FLOW_RATE_LIMITED
    ) {
      hybridImmutableChanged =
        normalizedCurrentConfig.duration !== normalizedTargetConfig.duration ||
        normalizedCurrentConfig.thresholdBps !==
          normalizedTargetConfig.thresholdBps ||
        (normalizedTargetConfig.warpRouter !== undefined &&
          normalizedCurrentConfig.warpRouter !==
            normalizedTargetConfig.warpRouter);
    } else if (
      typeof normalizedCurrentConfig !== 'string' &&
      normalizedCurrentConfig.type === IsmType.DELAYED_FLOW_ROUTER &&
      normalizedTargetConfig.type === IsmType.DELAYED_FLOW_ROUTER
    ) {
      hybridImmutableChanged =
        normalizedCurrentConfig.duration !== normalizedTargetConfig.duration ||
        normalizedCurrentConfig.thresholdBps !==
          normalizedTargetConfig.thresholdBps ||
        normalizedCurrentConfig.maxDelay !== normalizedTargetConfig.maxDelay ||
        (normalizedTargetConfig.warpRouter !== undefined &&
          normalizedCurrentConfig.warpRouter !==
            normalizedTargetConfig.warpRouter);
    }

    if (
      rateLimitedImmutableChanged ||
      blacklistRequiresRedeploy ||
      hybridImmutableChanged ||
      typeof normalizedCurrentConfig === 'string' ||
      normalizedCurrentConfig.type !== normalizedTargetConfig.type ||
      !MUTABLE_ISM_TYPE.includes(normalizedTargetConfig.type)
    ) {
      // For container ISM types (AGGREGATION, AMOUNT_ROUTING), attempt to update
      // sub-modules in-place before falling back to full redeployment. If all
      // sub-module addresses stay the same after updates, the container address is
      // preserved (no parent redeploy needed).
      if (
        typeof normalizedCurrentConfig !== 'string' &&
        normalizedCurrentConfig.type === normalizedTargetConfig.type &&
        (normalizedTargetConfig.type === IsmType.AGGREGATION ||
          normalizedTargetConfig.type === IsmType.AMOUNT_ROUTING)
      ) {
        const inPlaceTxs = await this.tryUpdateContainerIsm(
          normalizedCurrentConfig,
          normalizedTargetConfig,
        );
        if (inPlaceTxs !== null) {
          return inPlaceTxs;
        }
      }

      const contract = await this.deploy({
        config: normalizedTargetConfig,
      });

      this.args.addresses.deployedIsm = contract.address;
      return [];
    }

    // additional check for deploying new ISM if it is mutable incremental routing
    // and has updates to an existing domain
    if (
      normalizedCurrentConfig.type === IsmType.INCREMENTAL_ROUTING &&
      normalizedTargetConfig.type === IsmType.INCREMENTAL_ROUTING
    ) {
      const hasUpdates =
        calculateDomainRoutingDelta(
          normalizedCurrentConfig,
          normalizedTargetConfig,
        ).domainsToUpdate.length > 0;
      if (hasUpdates) {
        const contract = await this.deploy({
          config: normalizedTargetConfig,
        });
        this.args.addresses.deployedIsm = contract.address;
        return [];
      }
    }

    // At this point, only the ownable/mutable ISM types should remain: PAUSABLE, ROUTING, FALLBACK_ROUTING, OFFCHAIN_LOOKUP
    return this.updateMutableIsm({
      current: normalizedCurrentConfig,
      target: normalizedTargetConfig,
    });
  }

  protected async updateMutableIsm({
    current,
    target,
  }: {
    current: Exclude<IsmConfig, string>;
    target: Exclude<IsmConfig, string>;
  }): Promise<AnnotatedEV5Transaction[]> {
    const updateTxs: AnnotatedEV5Transaction[] = [];

    assert(
      MUTABLE_ISM_TYPE.includes(current.type),
      `Expected mutable ISM type but got ${current.type}`,
    );
    assert(
      current.type === target.type,
      `Updating Mutable ISMs requires both the expected and actual config to be of the same type`,
    );

    const logger = this.logger.child({
      destination: this.chain,
      ismType: target.type,
    });
    logger.debug(`Updating ${target.type} on ${this.chain}`);

    if (
      (current.type === IsmType.ROUTING && target.type === IsmType.ROUTING) ||
      (current.type === IsmType.FALLBACK_ROUTING &&
        target.type === IsmType.FALLBACK_ROUTING) ||
      (current.type === IsmType.INCREMENTAL_ROUTING &&
        target.type === IsmType.INCREMENTAL_ROUTING)
    ) {
      const txs = await this.updateRoutingIsm({
        current,
        target,
        logger,
      });

      updateTxs.push(...txs);
    } else if (
      current.type === IsmType.PAUSABLE &&
      target.type === IsmType.PAUSABLE
    ) {
      updateTxs.push(
        ...this.updatePausableIsm({
          current,
          target,
        }),
      );
    } else if (
      current.type === IsmType.OFFCHAIN_LOOKUP &&
      target.type === IsmType.OFFCHAIN_LOOKUP
    ) {
      updateTxs.push(
        ...this.updateOffchainLookupIsm({
          current,
          target,
        }),
      );
    } else if (
      current.type === IsmType.RATE_LIMITED &&
      target.type === IsmType.RATE_LIMITED
    ) {
      // owner is optional on RateLimitedIsmConfig — handle ownership here
      // rather than falling through to the generic transferOwnershipTransactions call
      return this.updateRateLimitedIsm({ current, target });
    } else if (
      current.type === IsmType.BLACKLIST &&
      target.type === IsmType.BLACKLIST
    ) {
      updateTxs.push(
        ...this.updateBlacklistIsm({
          current,
          target,
        }),
      );
    } else if (
      current.type === IsmType.NET_FLOW_RATE_LIMITED &&
      target.type === IsmType.NET_FLOW_RATE_LIMITED
    ) {
      // owner is optional on NetFlowRateLimitedHookIsmConfig — handle
      // ownership here rather than falling through to the generic
      // transferOwnershipTransactions call
      return this.updateNetFlowRateLimitedIsm({ current, target });
    } else if (
      current.type === IsmType.DELAYED_FLOW_ROUTER &&
      target.type === IsmType.DELAYED_FLOW_ROUTER
    ) {
      updateTxs.push(...(await this.updateDelayedFlowRouterIsm({ target })));
    } else {
      throw new Error(
        `Unsupported update to mutable ISM of type ${target.type}`,
      );
    }

    // Lastly, check if the resolved owner is different from the current owner
    updateTxs.push(
      ...transferOwnershipTransactions(
        this.chainId,
        this.args.addresses.deployedIsm,
        current,
        target,
      ),
    );

    return updateTxs;
  }

  // manually write static create function
  public static async create({
    chain,
    config,
    proxyFactoryFactories,
    mailbox,
    multiProvider,
    ccipContractCache,
    contractVerifier,
  }: {
    chain: ChainNameOrId;
    config: IsmConfig;
    proxyFactoryFactories: HyperlaneAddresses<ProxyFactoryFactories>;
    mailbox: Address;
    multiProvider: MultiProvider;
    ccipContractCache?: CCIPContractCache;
    contractVerifier?: ContractVerifier;
  }): Promise<EvmIsmModule> {
    const parsedConfig = IsmConfigSchema.parse(config);

    const module = new EvmIsmModule(
      multiProvider,
      {
        addresses: {
          ...proxyFactoryFactories,
          mailbox,
          deployedIsm: ethers.constants.AddressZero,
        },
        chain,
        config: parsedConfig,
      },
      ccipContractCache,
      contractVerifier,
    );

    const deployedIsm = await module.deploy({ config: parsedConfig });
    module.args.addresses.deployedIsm = deployedIsm.address;

    return module;
  }

  protected async updateRoutingIsm({
    current,
    target,
    logger,
  }: {
    current: DomainRoutingIsmConfig;
    target: DomainRoutingIsmConfig;
    logger: Logger;
  }): Promise<AnnotatedEV5Transaction[]> {
    const contract = DomainRoutingIsm__factory.connect(
      this.args.addresses.deployedIsm,
      this.multiProvider.getProvider(this.chain),
    );

    const updateTxs: AnnotatedEV5Transaction[] = [];

    const knownChains = new Set(this.multiProvider.getKnownChainNames());

    const { domainsToEnroll, domainsToUnenroll } = calculateDomainRoutingDelta(
      current,
      target,
    );

    const knownEnrolls = intersection(knownChains, new Set(domainsToEnroll));

    // Enroll domains
    for (const origin of knownEnrolls) {
      logger.debug(
        `Reconfiguring preexisting routing ISM for origin ${origin}...`,
      );
      const ism = await this.deploy({
        config: target.domains[origin],
      });

      const domainId = this.multiProvider.getDomainId(origin);
      const tx = await contract.populateTransaction.set(domainId, ism.address);
      updateTxs.push({
        chainId: this.chainId,
        annotation: `Setting new ISM for origin ${origin}...`,
        ...tx,
      });
    }

    const knownUnenrolls = intersection(
      knownChains,
      new Set(domainsToUnenroll),
    );

    // Unenroll domains
    for (const origin of knownUnenrolls) {
      const domainId = this.multiProvider.getDomainId(origin);
      const tx = await contract.populateTransaction.remove(domainId);
      updateTxs.push({
        chainId: this.chainId,
        annotation: `Unenrolling originDomain ${domainId} from preexisting routing ISM at ${this.args.addresses.deployedIsm}...`,
        ...tx,
      });
    }

    return updateTxs;
  }

  protected updatePausableIsm({
    current,
    target,
  }: {
    current: PausableIsmConfig;
    target: PausableIsmConfig;
  }): AnnotatedEV5Transaction[] {
    if (current.paused === target.paused) {
      return [];
    }

    const ismInterface = PausableIsm__factory.createInterface();
    const data = target.paused
      ? ismInterface.encodeFunctionData('pause')
      : ismInterface.encodeFunctionData('unpause');

    return [
      {
        annotation: `${target.paused ? 'Pausing' : 'Unpausing'} Pausable ISM on chain "${this.chain}" and address "${this.args.addresses.deployedIsm}"`,
        chainId: this.multiProvider.getEvmChainId(this.chain),
        to: this.args.addresses.deployedIsm,
        data,
      },
    ];
  }

  protected updateOffchainLookupIsm({
    current,
    target,
  }: {
    current: OffchainLookupIsmConfig;
    target: OffchainLookupIsmConfig;
  }): AnnotatedEV5Transaction[] {
    if (arrayEqual(target.urls, current.urls)) {
      return [];
    }

    return [
      {
        annotation: `Setting urls to ${target.type} ISM on chain "${this.chain}" and address "${this.args.addresses.deployedIsm}"`,
        chainId: this.multiProvider.getEvmChainId(this.chain),
        to: this.args.addresses.deployedIsm,
        // The contract code just replaces the existing array with the new one
        data: AbstractCcipReadIsm__factory.createInterface().encodeFunctionData(
          'setUrls(string[])',
          [target.urls],
        ),
      },
    ];
  }

  protected updateRateLimitedIsm({
    current,
    target,
  }: {
    current: RateLimitedIsmConfig;
    target: RateLimitedIsmConfig;
  }): AnnotatedEV5Transaction[] {
    const txs: AnnotatedEV5Transaction[] = [];

    // Duration changes are handled upstream in `update()` by redeploying a
    // fresh ISM (duration is immutable), so it never differs here.
    if (current.maxCapacity !== target.maxCapacity) {
      txs.push({
        annotation: `Setting maxCapacity on RateLimitedIsm on chain "${this.chain}" and address "${this.args.addresses.deployedIsm}"`,
        chainId: this.multiProvider.getEvmChainId(this.chain),
        to: this.args.addresses.deployedIsm,
        data: RateLimitedIsm__factory.createInterface().encodeFunctionData(
          'setRefillRate',
          [target.maxCapacity],
        ),
      });
    }

    if (current.owner != null && target.owner == null) {
      this.logger.warn(
        `target.owner is undefined for RateLimitedIsm on chain "${this.chain}" at address "${this.args.addresses.deployedIsm}"; ownership transfer will be skipped`,
      );
    } else if (current.owner != null && target.owner != null) {
      txs.push(
        ...transferOwnershipTransactions(
          this.chainId,
          this.args.addresses.deployedIsm,
          { owner: current.owner },
          { owner: target.owner },
        ),
      );
    }

    return txs;
  }

  // Deployments that predate the enumerable BlacklistIsm expose no `values()`.
  // They are phased out rather than appended to, so they are detected on-chain
  // instead of being represented in the config.
  private async isEnumerableBlacklistIsm(address: Address): Promise<boolean> {
    try {
      await BlacklistIsm__factory.connect(
        address,
        this.multiProvider.getProvider(this.chain),
      ).values();
      return true;
    } catch (error) {
      throwIfNotMissingSelector(error);
      return false;
    }
  }

  // Returns true when the target set is reachable by appending to the ISM
  // already deployed at `address`.
  private async blacklistCanBeUpdatedInPlace(
    address: Address,
    current: BlacklistIsmConfig,
    target: BlacklistIsmConfig,
  ): Promise<boolean> {
    if (!(await this.isEnumerableBlacklistIsm(address))) {
      return false;
    }

    return (
      calculateBlacklistDelta(current.blacklistedIds, target.blacklistedIds)
        .extras.length === 0
    );
  }

  protected updateBlacklistIsm({
    current,
    target,
  }: {
    current: BlacklistIsmConfig;
    target: BlacklistIsmConfig;
  }): AnnotatedEV5Transaction[] {
    // `extras` are handled upstream in `update()` by redeploying a fresh ISM
    // (entries are append-only), so only additions remain here.
    const { toAdd } = calculateBlacklistDelta(
      current.blacklistedIds,
      target.blacklistedIds,
    );
    if (toAdd.length === 0) {
      return [];
    }

    return [
      {
        annotation: `Blacklisting ${toAdd.length} message ID(s) on Blacklist ISM on chain "${this.chain}" and address "${this.args.addresses.deployedIsm}"`,
        chainId: this.multiProvider.getEvmChainId(this.chain),
        to: this.args.addresses.deployedIsm,
        data: BlacklistIsm__factory.createInterface().encodeFunctionData(
          'blacklist',
          [toAdd],
        ),
      },
    ];
  }

  protected updateNetFlowRateLimitedIsm({
    current,
    target,
  }: {
    current: NetFlowRateLimitedHookIsmConfig;
    target: NetFlowRateLimitedHookIsmConfig;
  }): AnnotatedEV5Transaction[] {
    // Rate params (warpRouter/thresholdBps/duration) are immutable and handled
    // upstream in update() by redeploying, so owner is the only field that can
    // differ here.
    if (current.owner != null && target.owner == null) {
      this.logger.warn(
        `target.owner is undefined for NetFlowRateLimitedHookIsm on chain "${this.chain}" at address "${this.args.addresses.deployedIsm}"; ownership transfer will be skipped`,
      );
      return [];
    }

    if (current.owner != null && target.owner != null) {
      return transferOwnershipTransactions(
        this.chainId,
        this.args.addresses.deployedIsm,
        { owner: current.owner },
        { owner: target.owner },
      );
    }

    return [];
  }

  protected async updateDelayedFlowRouterIsm({
    target,
  }: {
    target: DelayedFlowRouterHookIsmConfig;
  }): Promise<AnnotatedEV5Transaction[]> {
    // Rate params (warpRouter/thresholdBps/maxDelay/duration) are immutable
    // and handled upstream in update() by redeploying; ownership transfer is
    // handled by the generic tail in updateMutableIsm (after these txs, so the
    // owner-gated enrollment calls below are still executable by the current
    // owner). Only remote counterpart (`remoteIsms`) enrollment is reconciled
    // here — the on-chain calls keep Router nomenclature (enrollRemoteRouters).
    if (target.remoteIsms === undefined) {
      // omitted field — preserve the current on-chain enrollment
      return [];
    }

    // Read the live enumerable domain set rather than relying on the derived
    // config, which cannot name domains absent from the MultiProvider. This is
    // what lets an authoritative target remove stale unknown-domain peers.
    const delayedIsm = DelayedFlowRouterHookIsm__factory.connect(
      this.args.addresses.deployedIsm,
      this.multiProvider.getProvider(this.chain),
    );
    const currentDomains = (await delayedIsm.domains()).map(Number);
    const currentRouters = new Map<number, string>();
    await Promise.all(
      currentDomains.map(async (domain) => {
        currentRouters.set(
          domain,
          (await delayedIsm.routers(domain)).toLowerCase(),
        );
      }),
    );

    // The target remains canonicalized by known chain name so misspellings and
    // duplicate aliases fail before any transaction is emitted.
    const targetRouters = canonicalizeRemoteIsms(
      target.remoteIsms,
      this.multiProvider,
      `DelayedFlowRouterHookIsm on ${this.chain}`,
    );
    const targetRoutersByDomain = new Map<number, string>();
    for (const [chainName, router] of Object.entries(targetRouters)) {
      targetRoutersByDomain.set(
        this.multiProvider.getDomainId(chainName),
        router,
      );
    }

    const toEnrollDomains: number[] = [];
    const toEnrollRouters: string[] = [];
    for (const [domainId, targetRouter] of targetRoutersByDomain) {
      const currentRouter = currentRouters.get(domainId);
      if (currentRouter === undefined || currentRouter !== targetRouter) {
        toEnrollDomains.push(domainId);
        toEnrollRouters.push(targetRouter);
      }
    }

    const toUnenrollDomains: number[] = [];
    for (const domainId of currentRouters.keys()) {
      if (targetRoutersByDomain.has(domainId)) {
        continue;
      }
      toUnenrollDomains.push(domainId);
    }

    const ismInterface = DelayedFlowRouterHookIsm__factory.createInterface();
    const updateTxs: AnnotatedEV5Transaction[] = [];
    if (toEnrollDomains.length > 0) {
      updateTxs.push({
        annotation: `Enrolling ${toEnrollDomains.length} remote router(s) on DelayedFlowRouterHookIsm on chain "${this.chain}" and address "${this.args.addresses.deployedIsm}"`,
        chainId: this.chainId,
        to: this.args.addresses.deployedIsm,
        data: ismInterface.encodeFunctionData('enrollRemoteRouters', [
          toEnrollDomains,
          toEnrollRouters,
        ]),
      });
    }
    if (toUnenrollDomains.length > 0) {
      updateTxs.push({
        annotation: `Unenrolling ${toUnenrollDomains.length} remote router(s) on DelayedFlowRouterHookIsm on chain "${this.chain}" and address "${this.args.addresses.deployedIsm}"`,
        chainId: this.chainId,
        to: this.args.addresses.deployedIsm,
        data: ismInterface.encodeFunctionData('unenrollRemoteRouters', [
          toUnenrollDomains,
        ]),
      });
    }

    return updateTxs;
  }

  protected async deploy({
    config,
  }: {
    config: IsmConfig;
  }): Promise<DeployedIsm> {
    config = BaseIsmConfigSchema.parse(config);

    return this.ismFactory.deployInternal({
      destination: this.chain,
      config,
      mailbox: this.mailbox,
    });
  }

  // Attempts to update AGGREGATION or AMOUNT_ROUTING sub-modules in-place.
  // Returns accumulated transactions if all sub-module addresses are unchanged
  // (container address preserved), or null to fall back to full redeployment.
  private async tryUpdateContainerIsm(
    current: Exclude<IsmConfig, string>,
    target: IsmConfig,
  ): Promise<AnnotatedEV5Transaction[] | null> {
    const subModules = await this.containerSubModules(
      this.args.addresses.deployedIsm,
      current,
      target,
    );
    if (subModules === null) return null;

    for (const { address: origAddress, targetConfig } of subModules) {
      if (!(await this.canUpdateSubModuleInPlace(origAddress, targetConfig))) {
        return null;
      }
    }

    const allUpdateTxs: AnnotatedEV5Transaction[] = [];
    for (const { address: origAddress, targetConfig } of subModules) {
      const subModule = new EvmIsmModule(
        this.multiProvider,
        {
          chain: this.chain,
          config: targetConfig,
          addresses: { ...this.args.addresses, deployedIsm: origAddress },
        },
        this.ccipContractCache,
        this.contractVerifier,
      );
      allUpdateTxs.push(...(await subModule.updateInternal(targetConfig)));
      if (!eqAddress(origAddress, subModule.serialize().deployedIsm)) {
        return null;
      }
    }
    return allUpdateTxs;
  }

  private async containerSubModules(
    containerAddress: Address,
    current: Exclude<IsmConfig, string>,
    target: IsmConfig,
  ): Promise<ContainerSubModuleEntry[] | null> {
    const provider = this.multiProvider.getProvider(this.chain);

    if (
      typeof target !== 'string' &&
      current.type === IsmType.AGGREGATION &&
      target.type === IsmType.AGGREGATION
    ) {
      if (
        current.threshold !== target.threshold ||
        current.modules.length !== target.modules.length
      ) {
        return null;
      }
      const aggregationIsm = StaticAggregationIsm__factory.connect(
        containerAddress,
        provider,
      );
      const [onChainAddresses] = await aggregationIsm.modulesAndThreshold(
        ethers.constants.AddressZero,
      );
      if (onChainAddresses.length !== target.modules.length) return null;

      const onChainTyped = await Promise.all(
        onChainAddresses.map(async (addr) => {
          const cfg = await this.reader.deriveIsmConfig(addr);
          return { address: addr, key: this.ismConfigSortKey(cfg) };
        }),
      );

      const targetTyped = target.modules.map((targetConfig) => ({
        targetConfig,
        key: this.ismConfigSortKey(targetConfig),
      }));

      if (
        this.hasDuplicateSortKeys(onChainTyped.map(({ key }) => key)) ||
        this.hasDuplicateSortKeys(targetTyped.map(({ key }) => key))
      ) {
        return null;
      }

      onChainTyped.sort((a, b) => a.key.localeCompare(b.key));
      targetTyped.sort((a, b) => a.key.localeCompare(b.key));

      const subModules: ContainerSubModuleEntry[] = [];
      for (const [i, { address, key }] of onChainTyped.entries()) {
        if (key !== targetTyped[i].key) return null;
        subModules.push({
          address,
          targetConfig: targetTyped[i].targetConfig,
        });
      }
      return subModules;
    } else if (
      typeof target !== 'string' &&
      current.type === IsmType.AMOUNT_ROUTING &&
      target.type === IsmType.AMOUNT_ROUTING
    ) {
      if (current.threshold !== target.threshold) return null;
      const amountRoutingIsm = AmountRoutingIsm__factory.connect(
        containerAddress,
        provider,
      );
      const [lowerAddr, upperAddr] = await Promise.all([
        amountRoutingIsm.lower(),
        amountRoutingIsm.upper(),
      ]);
      return [
        { address: lowerAddr, targetConfig: target.lowerIsm },
        { address: upperAddr, targetConfig: target.upperIsm },
      ];
    } else {
      return null;
    }
  }

  private async canUpdateSubModuleInPlace(
    address: Address,
    targetConfig: IsmConfig,
  ): Promise<boolean> {
    const normalizedCurrentConfig = normalizeConfig(
      await this.reader.deriveIsmConfig(address),
    );
    const normalizedTargetConfig = normalizeConfig(
      await this.reader.deriveIsmConfig(targetConfig),
    );

    if (deepEquals(normalizedCurrentConfig, normalizedTargetConfig)) {
      return true;
    }

    if (typeof normalizedTargetConfig === 'string') {
      return eqAddress(address, normalizedTargetConfig);
    }

    if (
      typeof normalizedCurrentConfig === 'string' ||
      normalizedCurrentConfig.type !== normalizedTargetConfig.type
    ) {
      return false;
    }

    if (
      normalizedCurrentConfig.type === IsmType.AGGREGATION ||
      normalizedCurrentConfig.type === IsmType.AMOUNT_ROUTING
    ) {
      const subModules = await this.containerSubModules(
        address,
        normalizedCurrentConfig,
        normalizedTargetConfig,
      );
      if (subModules === null) return false;

      for (const {
        address: subModuleAddress,
        targetConfig: subModuleTarget,
      } of subModules) {
        if (
          !(await this.canUpdateSubModuleInPlace(
            subModuleAddress,
            subModuleTarget,
          ))
        ) {
          return false;
        }
      }
      return true;
    }

    if (!MUTABLE_ISM_TYPE.includes(normalizedTargetConfig.type)) {
      return false;
    }

    if (
      normalizedCurrentConfig.type === IsmType.INCREMENTAL_ROUTING &&
      normalizedTargetConfig.type === IsmType.INCREMENTAL_ROUTING
    ) {
      return (
        calculateDomainRoutingDelta(
          normalizedCurrentConfig,
          normalizedTargetConfig,
        ).domainsToUpdate.length === 0
      );
    }

    if (
      normalizedCurrentConfig.type === IsmType.BLACKLIST &&
      normalizedTargetConfig.type === IsmType.BLACKLIST
    ) {
      return this.blacklistCanBeUpdatedInPlace(
        address,
        normalizedCurrentConfig,
        normalizedTargetConfig,
      );
    }

    if (
      normalizedCurrentConfig.type === IsmType.RATE_LIMITED &&
      normalizedTargetConfig.type === IsmType.RATE_LIMITED &&
      normalizedTargetConfig.recipient !== undefined
    ) {
      const onChainRecipient = await RateLimitedIsm__factory.connect(
        address,
        this.multiProvider.getProvider(this.chain),
      ).recipient();
      return eqAddress(onChainRecipient, normalizedTargetConfig.recipient);
    }

    // The warp-route hybrid hook/ISMs can only be updated in place when their
    // immutable rate params match — otherwise update() redeploys them, which
    // changes the sub-module address and forces a container redeploy anyway.
    if (
      normalizedCurrentConfig.type === IsmType.NET_FLOW_RATE_LIMITED &&
      normalizedTargetConfig.type === IsmType.NET_FLOW_RATE_LIMITED
    ) {
      return (
        normalizedCurrentConfig.duration === normalizedTargetConfig.duration &&
        normalizedCurrentConfig.thresholdBps ===
          normalizedTargetConfig.thresholdBps &&
        (normalizedTargetConfig.warpRouter === undefined ||
          normalizedCurrentConfig.warpRouter ===
            normalizedTargetConfig.warpRouter)
      );
    }
    if (
      normalizedCurrentConfig.type === IsmType.DELAYED_FLOW_ROUTER &&
      normalizedTargetConfig.type === IsmType.DELAYED_FLOW_ROUTER
    ) {
      return (
        normalizedCurrentConfig.duration === normalizedTargetConfig.duration &&
        normalizedCurrentConfig.thresholdBps ===
          normalizedTargetConfig.thresholdBps &&
        normalizedCurrentConfig.maxDelay === normalizedTargetConfig.maxDelay &&
        (normalizedTargetConfig.warpRouter === undefined ||
          normalizedCurrentConfig.warpRouter ===
            normalizedTargetConfig.warpRouter)
      );
    }

    return true;
  }

  private ismConfigSortKey(config: IsmConfig): string {
    return typeof config === 'string' ? config : config.type;
  }

  private hasDuplicateSortKeys(keys: string[]): boolean {
    return new Set(keys).size !== keys.length;
  }
}
