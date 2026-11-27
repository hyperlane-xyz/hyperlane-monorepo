import { getArbitrumNetwork } from '@arbitrum/sdk';
import { BigNumber, ethers } from 'ethers';

import { compareVersions } from 'compare-versions';

import {
  AmountRoutingHook,
  ArbL2ToL1Hook,
  ArbL2ToL1Ism__factory,
  CCIPHook,
  CCIPHook__factory,
  DomainRoutingHook,
  DomainRoutingHook__factory,
  FallbackDomainRoutingHook,
  FallbackDomainRoutingHook__factory,
  IL1CrossDomainMessenger__factory,
  IPostDispatchHook__factory,
  InterchainGasPaymaster,
  InterchainGasPaymaster__factory,
  MailboxClient__factory,
  OPStackHook,
  OPStackIsm__factory,
  Ownable__factory,
  PausableHook,
  PausableHook__factory,
  ProxyAdmin__factory,
  ProtocolFee,
  ProtocolFee__factory,
  RateLimitedHook,
  RateLimitedHook__factory,
  StaticAggregationHook,
  StaticAggregationHookFactory__factory,
  StaticAggregationHook__factory,
  StorageGasOracle,
  StorageGasOracle__factory,
} from '@hyperlane-xyz/core';
import {
  Address,
  Domain,
  EvmChainId,
  ProtocolType,
  ZERO_ADDRESS_HEX_32,
  addressToBytes32,
  assert,
  deepCopy,
  deepEquals,
  difference,
  eqAddress,
  isZeroishAddress,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { CCIPContractCache } from '../ccip/utils.js';
import { TOKEN_EXCHANGE_RATE_SCALE_ETHEREUM } from '../consts/igp.js';
import { HyperlaneAddresses } from '../contracts/types.js';
import {
  HyperlaneModule,
  HyperlaneModuleParams,
} from '../core/AbstractHyperlaneModule.js';
import { CoreAddresses } from '../core/contracts.js';
import { HyperlaneDeployer } from '../deploy/HyperlaneDeployer.js';
import { ProxyFactoryFactories } from '../deploy/contracts.js';
import { isProxy, proxyAdmin } from '../deploy/proxy.js';
import { ContractVerifier } from '../deploy/verify/ContractVerifier.js';
import {
  IgpConfig,
  assertTokenOracleConfigHasNativeRemotes,
  igpSupportsOffchainFeeQuoting,
} from '../gas/types.js';
import { EvmIsmModule } from '../ism/EvmIsmModule.js';
import { HyperlaneIsmFactory } from '../ism/HyperlaneIsmFactory.js';
import { ArbL2ToL1IsmConfig, IsmType, OpStackIsmConfig } from '../ism/types.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { AnnotatedEV5Transaction } from '../providers/ProviderType.js';
import { ChainName, ChainNameOrId } from '../types.js';
import { normalizeConfig } from '../utils/ism.js';
import { fetchPackageVersion } from '../utils/contract.js';

import {
  VERSION_ERROR_MESSAGE,
  contractVersionMatchesDependency,
} from '../token/types.js';

import { EvmHookReader } from './EvmHookReader.js';
import { DeployedHook, HookFactories, hookFactories } from './contracts.js';
import {
  collapseMatchingCombinedHookIsmNodes,
  isCombinedHookIsmHookNode,
  resolveCombinedHookIsmNodesToAddress,
} from './utils.js';
import {
  AggregationHookConfig,
  AmountRoutingHookConfig,
  ArbL2ToL1HookConfig,
  CCIPHookConfig,
  DerivedHookConfig,
  DomainRoutingHookConfig,
  FallbackRoutingHookConfig,
  HookConfig,
  HookConfigSchema,
  HookType,
  HookTypeToContractNameMap,
  IgpHookConfig,
  IgpVersion,
  MUTABLE_HOOK_TYPE,
  OFFCHAIN_QUOTED_IGP_VERSION,
  OpStackHookConfig,
  PausableHookConfig,
  ProtocolFeeHookConfig,
  RateLimitedHookConfig,
} from './types.js';

type HookModuleAddresses = {
  deployedHook: Address;
  mailbox: Address;
  proxyAdmin: Address;
  // Injected by warp deploy path; used as constructor arg for RateLimitedHook.
  rateLimitedSender?: Address;
};

class HookDeployer extends HyperlaneDeployer<{}, HookFactories> {
  protected cachingEnabled = false;

  deployContracts(_chain: ChainName, _config: {}): Promise<any> {
    throw new Error('Method not implemented.');
  }
}

function stripIgpVersion(config: unknown): unknown {
  if (Array.isArray(config)) {
    return config.map(stripIgpVersion);
  }

  if (config !== null && typeof config === 'object') {
    const stripped: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(config)) {
      if (key !== 'igpVersion') {
        stripped[key] = stripIgpVersion(value);
      }
    }
    return stripped;
  }

  return config;
}

function hookConfigsEqual(a: unknown, b: unknown): boolean {
  return deepEquals(stripIgpVersion(a), stripIgpVersion(b));
}

function hasDuplicateKeys(keys: string[]): boolean {
  return new Set(keys).size !== keys.length;
}

// The address of the deployed hook that a config only refers to, if it is one.
function referencedHookAddress(hook: HookConfig): Address | undefined {
  if (typeof hook === 'string') return hook;
  switch (hook.type) {
    case HookType.CCTP:
    case HookType.PREDICATE:
      return hook.address;
    case HookType.UNKNOWN:
      return typeof hook.address === 'string' ? hook.address : undefined;
    default:
      return undefined;
  }
}

// The addresses of the hooks that a target gives as an address, in its aggregations too.
function referencedHookAddresses(hook: HookConfig): Address[] {
  const address = referencedHookAddress(hook);
  if (address !== undefined) return [address];
  return typeof hook !== 'string' && hook.type === HookType.AGGREGATION
    ? hook.hooks.flatMap(referencedHookAddresses)
    : [];
}

type AggregationSubHook = {
  address: Address;
  targetConfig: Exclude<HookConfig, Address>;
};

export class EvmHookModule extends HyperlaneModule<
  ProtocolType.Ethereum,
  HookConfig,
  HyperlaneAddresses<ProxyFactoryFactories> & HookModuleAddresses
> {
  static protocols = [ProtocolType.Ethereum, ProtocolType.Tron];
  protected readonly logger = rootLogger.child({ module: 'EvmHookModule' });
  protected readonly reader: EvmHookReader;
  // "ISM" Factory has aggregation hook factories too
  protected readonly hookFactory: HyperlaneIsmFactory;
  protected readonly deployer: HookDeployer;

  // Adding these to reduce how often we need to grab from MultiProvider.
  public readonly chain: ChainName;
  public readonly chainId: EvmChainId;
  public readonly domainId: Domain;

  // Transaction overrides for the chain
  protected readonly txOverrides: Partial<ethers.providers.TransactionRequest>;

  constructor(
    protected readonly multiProvider: MultiProvider,
    params: HyperlaneModuleParams<
      HookConfig,
      HyperlaneAddresses<ProxyFactoryFactories> & HookModuleAddresses
    >,
    ccipContractCache?: CCIPContractCache,
    protected readonly contractVerifier?: ContractVerifier,
  ) {
    params.config = HookConfigSchema.parse(params.config);
    super(params);

    this.reader = new EvmHookReader(multiProvider, this.args.chain);
    this.hookFactory = HyperlaneIsmFactory.fromAddressesMap(
      { [this.args.chain]: params.addresses },
      multiProvider,
      ccipContractCache,
      contractVerifier,
    );
    this.deployer = new HookDeployer(multiProvider, hookFactories);

    this.chain = multiProvider.getChainName(this.args.chain);
    this.chainId = multiProvider.getEvmChainId(this.chain);
    this.domainId = multiProvider.getDomainId(this.chain);

    this.txOverrides = multiProvider.getTransactionOverrides(this.chain);
  }

  public async read(): Promise<DerivedHookConfig | string> {
    if (typeof this.args.config === 'string') {
      return this.args.addresses.deployedHook;
    }

    // For IGP hooks with tokenOracleConfig, pass fee tokens to the reader
    if (
      typeof this.args.config === 'object' &&
      this.args.config.type === HookType.INTERCHAIN_GAS_PAYMASTER &&
      this.args.config.tokenOracleConfig
    ) {
      const feeTokens = Object.keys(this.args.config.tokenOracleConfig);
      return this.reader.deriveIgpConfig(
        this.args.addresses.deployedHook,
        feeTokens,
      );
    }

    return this.reader.deriveHookConfig(this.args.addresses.deployedHook);
  }

  public async update(
    targetConfig: HookConfig,
    opaqueCombinedHookIsmAddresses: Address[] = [],
  ): Promise<AnnotatedEV5Transaction[]> {
    // Nothing to do if its the default hook
    if (typeof targetConfig === 'string' && isZeroishAddress(targetConfig)) {
      return [];
    }

    // deriveHookConfig replaces the address members of an aggregation with their derived
    // configs in place. It derives from a copy, so that the target of the caller keeps
    // them, and the in-place aggregation update gets them as given.
    const givenTargetConfig: HookConfig = deepCopy(targetConfig);

    // We need to normalize the current and target configs to compare.
    const derivedTargetConfig = await this.reader.deriveHookConfig(
      deepCopy(targetConfig),
    );
    let normalizedTargetConfig: HookConfig =
      typeof targetConfig === 'string' &&
      isCombinedHookIsmHookNode(derivedTargetConfig)
        ? targetConfig
        : normalizeConfig(derivedTargetConfig);
    for (const address of opaqueCombinedHookIsmAddresses) {
      normalizedTargetConfig = resolveCombinedHookIsmNodesToAddress(
        normalizedTargetConfig,
        address,
      );
    }
    normalizedTargetConfig = normalizeConfig(normalizedTargetConfig);
    let currentConfig: HookConfig = await this.read();
    for (const address of opaqueCombinedHookIsmAddresses) {
      currentConfig = collapseMatchingCombinedHookIsmNodes(
        currentConfig,
        address,
      );
    }
    const normalizedCurrentConfig: HookConfig = normalizeConfig(currentConfig);

    // If configs match, no updates needed
    if (hookConfigsEqual(normalizedCurrentConfig, normalizedTargetConfig)) {
      return [];
    }

    // Update the module config to the target one as we are sure now that an update will be needed
    this.args.config = normalizedTargetConfig;

    // if the new config is an address just point the module to the new address
    if (typeof normalizedTargetConfig === 'string') {
      this.args.addresses.deployedHook = normalizedTargetConfig;

      return [];
    }

    // Special case: RATE_LIMITED duration is immutable (set in the
    // constructor) — must redeploy a fresh hook if it changes.
    const rateLimitedDurationChanged =
      typeof normalizedCurrentConfig !== 'string' &&
      normalizedCurrentConfig.type === HookType.RATE_LIMITED &&
      normalizedTargetConfig.type === HookType.RATE_LIMITED &&
      normalizedCurrentConfig.duration !== normalizedTargetConfig.duration;

    // Conditions for deploying a new hook:
    // - If updating from an address/custom config to a proper hook config.
    // - If updating a proper hook config whose types are different.
    // - If it is not a mutable Hook. An AGGREGATION hook is only deployed when its
    //   members cannot be updated in place.
    // - If an immutable RATE_LIMITED field (duration) changed.
    if (
      rateLimitedDurationChanged ||
      typeof normalizedCurrentConfig === 'string' ||
      normalizedCurrentConfig.type !== normalizedTargetConfig.type ||
      !MUTABLE_HOOK_TYPE.includes(normalizedTargetConfig.type)
    ) {
      // The addresses of the hybrid hook and ISM resolve nodes of the target that the
      // in-place update, which goes by the target as it was given, does not see.
      if (
        opaqueCombinedHookIsmAddresses.length === 0 &&
        typeof normalizedCurrentConfig !== 'string' &&
        normalizedCurrentConfig.type === HookType.AGGREGATION &&
        typeof givenTargetConfig !== 'string' &&
        givenTargetConfig.type === HookType.AGGREGATION
      ) {
        const inPlaceTxs = await this.tryUpdateContainerHook(givenTargetConfig);
        if (inPlaceTxs !== null) {
          return inPlaceTxs;
        }
      }

      const contract = await this.deploy({
        config: normalizedTargetConfig,
      });

      this.args.addresses.deployedHook = contract.address;
      return [];
    }

    // Only mutable hooks reach this call, the others were updated in place or deployed above
    return this.updateMutableHook({
      current: normalizedCurrentConfig,
      target: normalizedTargetConfig,
    });
  }

  // Returns the transactions that update the members of the deployed AGGREGATION
  // hook in place, or null when that would change the address of any member and the
  // aggregation has to be redeployed. Nothing is sent or deployed before every member
  // is known to be updatable in place.
  protected async tryUpdateContainerHook(
    target: AggregationHookConfig,
  ): Promise<AnnotatedEV5Transaction[] | null> {
    const subHooks = await this.containerSubHooks(
      this.args.addresses.deployedHook,
      target,
    );
    if (subHooks === null) return null;

    for (const { address, targetConfig } of subHooks) {
      if (!(await this.canUpdateSubHookInPlace(address, targetConfig))) {
        return null;
      }
    }

    const allUpdateTxs: AnnotatedEV5Transaction[] = [];
    for (const { address, targetConfig } of subHooks) {
      const subModule = new EvmHookModule(
        this.multiProvider,
        {
          chain: this.chain,
          config: targetConfig,
          addresses: { ...this.args.addresses, deployedHook: address },
        },
        this.hookFactory.ccipContractCache,
        this.contractVerifier,
      );
      allUpdateTxs.push(...(await subModule.update(targetConfig)));
      if (!eqAddress(address, subModule.serialize().deployedHook)) {
        return null;
      }
    }
    return allUpdateTxs;
  }

  // Pairs the members of the deployed AGGREGATION hook with the members of the target
  // that need an update. Members of the target that only refer to a deployed hook (an
  // address, or a CCTP, predicate or unknown hook, which is only an address) are kept
  // unchanged, so they have to be members of the deployed hook. The remaining members
  // are paired by hook type.
  protected async containerSubHooks(
    containerAddress: Address,
    target: AggregationHookConfig,
  ): Promise<AggregationSubHook[] | null> {
    const onChainAddresses = await StaticAggregationHook__factory.connect(
      containerAddress,
      this.multiProvider.getProvider(this.chain),
    ).hooks(ethers.constants.AddressZero);
    if (onChainAddresses.length !== target.hooks.length) return null;

    const unmatched = await Promise.all(
      onChainAddresses.map(async (address) => {
        const { type } = await this.reader.deriveHookConfig(address);
        return { address, key: type };
      }),
    );

    const pairedTargets: Exclude<HookConfig, Address>[] = [];
    for (const member of target.hooks) {
      const keptAddress = referencedHookAddress(member);
      if (keptAddress === undefined) {
        // an unknown hook that has no address cannot be told apart from the deployed ones
        if (typeof member === 'string' || member.type === HookType.UNKNOWN) {
          return null;
        }
        pairedTargets.push(member);
        continue;
      }

      const index = unmatched.findIndex((onChain) =>
        eqAddress(onChain.address, keptAddress),
      );
      if (index === -1) return null;
      unmatched.splice(index, 1);
    }

    const targetKeys = pairedTargets.map(({ type }) => type);
    if (
      hasDuplicateKeys(unmatched.map(({ key }) => key)) ||
      hasDuplicateKeys(targetKeys)
    ) {
      return null;
    }

    const sortedUnmatched = [...unmatched].sort((a, b) =>
      a.key.localeCompare(b.key),
    );
    const sortedTargets = [...pairedTargets].sort((a, b) =>
      a.type.localeCompare(b.type),
    );

    const subHooks: AggregationSubHook[] = [];
    for (const [i, { address, key }] of sortedUnmatched.entries()) {
      const paired = sortedTargets[i];
      if (paired === undefined || key !== paired.type) return null;
      subHooks.push({ address, targetConfig: paired });
    }
    return subHooks;
  }

  // Whether updating the hook at `address` to `targetConfig` keeps its address.
  protected async canUpdateSubHookInPlace(
    address: Address,
    targetConfig: Exclude<HookConfig, Address>,
  ): Promise<boolean> {
    // A target given with an address has to be the hook at `address`, which the equality of
    // the configs, that omits the address, does not tell.
    const referencedAddress = referencedHookAddress(targetConfig);
    if (
      referencedAddress !== undefined &&
      !eqAddress(referencedAddress, address)
    ) {
      return false;
    }

    const current: HookConfig = normalizeConfig(
      await this.reader.deriveHookConfig(address),
    );
    const target: HookConfig = normalizeConfig(
      await this.reader.deriveHookConfig(deepCopy(targetConfig)),
    );

    if (
      typeof current === 'string' ||
      typeof target === 'string' ||
      current.type !== target.type
    ) {
      return false;
    }

    // The members that an aggregation is given as an address have to be members of it,
    // which the equality of the configs, that omits the address, does not tell.
    const hasReferencedMembers =
      current.type === HookType.AGGREGATION &&
      referencedHookAddresses(targetConfig).length > 0;
    // The equal configs of a fallback routing member omit the address and the mailbox of
    // its fallback, which is checked below.
    if (
      hookConfigsEqual(current, target) &&
      !hasReferencedMembers &&
      current.type !== HookType.FALLBACK_ROUTING
    ) {
      return this.keptHookUsesModuleMailbox(address);
    }

    if (
      current.type === HookType.AGGREGATION &&
      targetConfig.type === HookType.AGGREGATION
    ) {
      const subHooks = await this.containerSubHooks(address, targetConfig);
      if (subHooks === null) return false;

      for (const subHook of subHooks) {
        if (
          !(await this.canUpdateSubHookInPlace(
            subHook.address,
            subHook.targetConfig,
          ))
        ) {
          return false;
        }
      }
      return true;
    }

    if (!MUTABLE_HOOK_TYPE.includes(target.type)) {
      return false;
    }

    if (
      current.type === HookType.RATE_LIMITED &&
      target.type === HookType.RATE_LIMITED
    ) {
      return current.duration === target.duration;
    }

    if (
      current.type === HookType.PROTOCOL_FEE &&
      target.type === HookType.PROTOCOL_FEE
    ) {
      return current.maxProtocolFee === target.maxProtocolFee;
    }

    // An update in place sets the destinations of the target and keeps the other ones
    if (
      (current.type === HookType.ROUTING ||
        current.type === HookType.FALLBACK_ROUTING) &&
      (target.type === HookType.ROUTING ||
        target.type === HookType.FALLBACK_ROUTING) &&
      Object.keys(current.domains).some((domain) => !(domain in target.domains))
    ) {
      return false;
    }

    if (
      current.type === HookType.FALLBACK_ROUTING &&
      target.type === HookType.FALLBACK_ROUTING &&
      targetConfig.type === HookType.FALLBACK_ROUTING
    ) {
      if (!hookConfigsEqual(current.fallback, target.fallback)) return false;

      // The deployed fallback has to be the hook that the target gives with its address, or
      // one that is kept unchanged.
      const deployedFallback = await FallbackDomainRoutingHook__factory.connect(
        address,
        this.multiProvider.getProvider(this.chain),
      ).fallbackHook();
      return typeof targetConfig.fallback === 'string'
        ? eqAddress(targetConfig.fallback, deployedFallback)
        : this.canUpdateSubHookInPlace(deployedFallback, targetConfig.fallback);
    }

    // An update in place reuses the gas oracle, and does not transfer its ownership
    if (
      current.type === HookType.INTERCHAIN_GAS_PAYMASTER &&
      target.type === HookType.INTERCHAIN_GAS_PAYMASTER &&
      !eqAddress(current.oracleKey, target.oracleKey)
    ) {
      return false;
    }

    return true;
  }

  // The mailbox is an immutable constructor arg that the reader omits, so a MAILBOX_DEFAULT
  // or MERKLE_TREE hook bound to another mailbox compares equal to one bound to this
  // module's. Checks the hook, the members of an aggregation and the fallback of a fallback
  // routing hook, that are kept unchanged.
  protected async keptHookUsesModuleMailbox(
    address: Address,
  ): Promise<boolean> {
    const provider = this.multiProvider.getProvider(this.chain);
    const { type } = await this.reader.deriveHookConfig(address);

    if (type === HookType.AGGREGATION) {
      const members = await StaticAggregationHook__factory.connect(
        address,
        provider,
      ).hooks(ethers.constants.AddressZero);
      for (const member of members) {
        if (!(await this.keptHookUsesModuleMailbox(member))) return false;
      }
      return true;
    }

    if (type === HookType.FALLBACK_ROUTING) {
      return this.keptHookUsesModuleMailbox(
        await FallbackDomainRoutingHook__factory.connect(
          address,
          provider,
        ).fallbackHook(),
      );
    }

    if (type === HookType.MAILBOX_DEFAULT || type === HookType.MERKLE_TREE) {
      const mailbox = await MailboxClient__factory.connect(
        address,
        provider,
      ).mailbox();
      return eqAddress(mailbox, this.args.addresses.mailbox);
    }

    return true;
  }

  // manually write static create function
  public static async create({
    chain,
    config,
    proxyFactoryFactories,
    coreAddresses,
    multiProvider,
    ccipContractCache,
    contractVerifier,
  }: {
    chain: ChainNameOrId;
    config: HookConfig;
    proxyFactoryFactories: HyperlaneAddresses<ProxyFactoryFactories>;
    coreAddresses: Omit<CoreAddresses, 'validatorAnnounce' | 'quotedCalls'> & {
      rateLimitedSender?: Address;
    };
    multiProvider: MultiProvider;
    ccipContractCache?: CCIPContractCache;
    contractVerifier?: ContractVerifier;
  }): Promise<EvmHookModule> {
    const module = new EvmHookModule(
      multiProvider,
      {
        addresses: {
          ...proxyFactoryFactories,
          ...coreAddresses,
          deployedHook: ethers.constants.AddressZero,
        },
        chain,
        config,
      },
      ccipContractCache,
      contractVerifier,
    );

    const deployedHook = await module.deploy({ config });
    module.args.addresses.deployedHook = deployedHook.address;

    return module;
  }

  // Compute delta between current and target domain configurations
  protected async computeRoutingHooksToSet({
    currentDomains,
    targetDomains,
  }: {
    currentDomains: DomainRoutingHookConfig['domains'];
    targetDomains: DomainRoutingHookConfig['domains'];
  }): Promise<DomainRoutingHook.HookConfigStruct[]> {
    const routingHookUpdates: DomainRoutingHook.HookConfigStruct[] = [];

    // Iterate over the target domains and compare with the current configuration
    for (const [dest, targetDomainConfig] of Object.entries(targetDomains)) {
      const destDomain = this.multiProvider.tryGetDomainId(dest);
      if (!destDomain) {
        this.logger.warn(`Domain not found in MultiProvider: ${dest}`);
        continue;
      }

      // If the domain is not in the current config or the config has changed, deploy a new hook
      // TODO: in-place updates per domain as a future optimization
      if (!hookConfigsEqual(currentDomains[dest], targetDomainConfig)) {
        const domainHook = await this.deploy({
          config: targetDomainConfig,
        });

        routingHookUpdates.push({
          destination: destDomain,
          hook: domainHook.address,
        });
      }
    }

    return routingHookUpdates;
  }

  protected async updateMutableHook(configs: {
    current: Exclude<HookConfig, string>;
    target: Exclude<HookConfig, string>;
  }): Promise<AnnotatedEV5Transaction[]> {
    const { current, target } = configs;
    let updateTxs: AnnotatedEV5Transaction[];

    assert(
      current.type === target.type,
      `Mutable hook update requires both hook configs to be of the same type. Expected ${current.type}, got ${target.type}`,
    );
    assert(
      MUTABLE_HOOK_TYPE.includes(current.type),
      'Expected update config to be of mutable hook type',
    );
    // Checking both objects type fields to help typescript narrow the type down correctly
    if (
      current.type === HookType.INTERCHAIN_GAS_PAYMASTER &&
      target.type === HookType.INTERCHAIN_GAS_PAYMASTER
    ) {
      updateTxs = await this.updateIgpHook({
        currentConfig: current,
        targetConfig: target,
      });
    } else if (
      current.type === HookType.PROTOCOL_FEE &&
      target.type === HookType.PROTOCOL_FEE
    ) {
      updateTxs = await this.updateProtocolFeeHook({
        currentConfig: current,
        targetConfig: target,
      });
    } else if (
      current.type === HookType.PAUSABLE &&
      target.type === HookType.PAUSABLE
    ) {
      updateTxs = await this.updatePausableHook({
        currentConfig: current,
        targetConfig: target,
      });
    } else if (
      (current.type === HookType.ROUTING && target.type === HookType.ROUTING) ||
      (current.type === HookType.FALLBACK_ROUTING &&
        target.type === HookType.FALLBACK_ROUTING)
    ) {
      updateTxs = await this.updateRoutingHook({
        currentConfig: current,
        targetConfig: target,
      });
    } else if (
      current.type === HookType.RATE_LIMITED &&
      target.type === HookType.RATE_LIMITED
    ) {
      updateTxs = await this.updateRateLimitedHook({
        currentConfig: current,
        targetConfig: target,
      });
    } else {
      throw new Error(`Unsupported hook type: ${target.type}`);
    }

    // Lastly, check if the resolved owner is different from the current owner
    const owner = await Ownable__factory.connect(
      this.args.addresses.deployedHook,
      this.multiProvider.getProvider(this.chain),
    ).owner();

    // Return an ownership transfer transaction if required
    if (!eqAddress(target.owner, owner)) {
      updateTxs.push({
        annotation: 'Transferring ownership of ownable Hook...',
        chainId: this.chainId,
        to: this.args.addresses.deployedHook,
        data: Ownable__factory.createInterface().encodeFunctionData(
          'transferOwnership(address)',
          [target.owner],
        ),
      });
    }

    return updateTxs;
  }

  protected async updatePausableHook({
    currentConfig,
    targetConfig,
  }: {
    currentConfig: PausableHookConfig;
    targetConfig: PausableHookConfig;
  }): Promise<AnnotatedEV5Transaction[]> {
    const updateTxs: AnnotatedEV5Transaction[] = [];

    if (currentConfig.paused !== targetConfig.paused) {
      // Have to encode separately otherwise tsc will complain
      // about being unable to infer types correctly
      const pausableInterface = PausableHook__factory.createInterface();
      const data = targetConfig.paused
        ? pausableInterface.encodeFunctionData('pause')
        : pausableInterface.encodeFunctionData('unpause');

      updateTxs.push({
        annotation: `Updating paused state to ${targetConfig.paused}`,
        chainId: this.chainId,
        to: this.args.addresses.deployedHook,
        data,
      });
    }

    return updateTxs;
  }

  protected async updateRateLimitedHook({
    currentConfig,
    targetConfig,
  }: {
    currentConfig: RateLimitedHookConfig;
    targetConfig: RateLimitedHookConfig;
  }): Promise<AnnotatedEV5Transaction[]> {
    const updateTxs: AnnotatedEV5Transaction[] = [];

    // Duration changes are handled upstream in `update()` by redeploying a
    // fresh hook (duration is immutable), so it never differs here.
    if (currentConfig.maxCapacity !== targetConfig.maxCapacity) {
      updateTxs.push({
        annotation: `Setting refill rate on RateLimitedHook on chain "${this.chain}" and address "${this.args.addresses.deployedHook}"`,
        chainId: this.chainId,
        to: this.args.addresses.deployedHook,
        data: RateLimitedHook__factory.createInterface().encodeFunctionData(
          'setRefillRate',
          [targetConfig.maxCapacity],
        ),
      });
    }

    return updateTxs;
  }

  protected async updateIgpHook({
    currentConfig,
    targetConfig,
  }: {
    currentConfig: IgpHookConfig;
    targetConfig: IgpHookConfig;
  }): Promise<AnnotatedEV5Transaction[]> {
    const updateTxs: AnnotatedEV5Transaction[] = [];
    const igpAddress = this.args.addresses.deployedHook;
    const igpInterface = InterchainGasPaymaster__factory.createInterface();
    const provider = this.multiProvider.getProvider(this.domainId);
    const currentVersion = await fetchPackageVersion(
      provider,
      igpAddress,
      this.logger,
    );

    // Upgrade IGP proxy implementation only if contractVersion is specified in config
    if (targetConfig.contractVersion && (await isProxy(provider, igpAddress))) {
      assert(
        contractVersionMatchesDependency(targetConfig.contractVersion),
        VERSION_ERROR_MESSAGE,
      );

      if (compareVersions(targetConfig.contractVersion, currentVersion) > 0) {
        this.logger.info(
          `Upgrading IGP implementation from ${currentVersion} to ${targetConfig.contractVersion}`,
        );
        const newImpl = await this.deployer.deployContractFromFactory(
          this.chain,
          new InterchainGasPaymaster__factory(),
          HookType.INTERCHAIN_GAS_PAYMASTER,
          [],
        );
        const igpProxyAdmin = await proxyAdmin(provider, igpAddress);
        updateTxs.push({
          annotation: `Upgrade IGP proxy implementation to ${targetConfig.contractVersion}`,
          chainId: this.chainId,
          to: igpProxyAdmin,
          data: ProxyAdmin__factory.createInterface().encodeFunctionData(
            'upgrade',
            [igpAddress, newImpl.address],
          ),
        });
      }
    }

    // Update beneficiary if changed
    if (!eqAddress(currentConfig.beneficiary, targetConfig.beneficiary)) {
      updateTxs.push({
        annotation: `Updating beneficiary from ${currentConfig.beneficiary} to ${targetConfig.beneficiary}`,
        chainId: this.chainId,
        to: this.args.addresses.deployedHook,
        data: igpInterface.encodeFunctionData('setBeneficiary(address)', [
          targetConfig.beneficiary,
        ]),
      });
    }

    // get gasOracleAddress using any remote domain in the current config
    let gasOracle;
    const domainKeys = Object.keys(currentConfig.oracleConfig);

    // If possible, reuse and reconfigure the gas oracle from the first remote we know.
    // Otherwise if there are no remotes in current config, deploy a new gas oracle with our target config.
    // We should be reusing the same oracle for all remotes, but if not, the updateIgpRemoteGasParams step will rectify this
    if (domainKeys.length > 0) {
      const domainId = this.multiProvider.getDomainId(domainKeys[0]);
      ({ gasOracle } = await InterchainGasPaymaster__factory.connect(
        this.args.addresses.deployedHook,
        this.multiProvider.getSignerOrProvider(this.chain),
      )['destinationGasConfigs(uint32)'](domainId));

      // update storage gas oracle
      // Note: this will only update the gas oracle for remotes that are in the target config
      updateTxs.push(
        ...(await this.updateStorageGasOracle({
          gasOracle,
          currentOracleConfig: currentConfig.oracleConfig,
          targetOracleConfig: targetConfig.oracleConfig,
          targetOverhead: targetConfig.overhead, // used to log example remote gas costs
        })),
      );
    } else {
      assert(
        targetConfig.igpVersion !== IgpVersion.Legacy,
        'Legacy IGP updates require an existing gas oracle configuration',
      );

      const newGasOracle = await this.deployStorageGasOracle({
        config: targetConfig,
      });
      gasOracle = newGasOracle.address;
    }

    // update igp remote gas params
    // Note: this will only update the gas params for remotes that are in the target config
    updateTxs.push(
      ...(await this.updateIgpRemoteGasParams({
        interchainGasPaymaster: this.args.addresses.deployedHook,
        gasOracle,
        currentOverheads: currentConfig.overhead,
        targetOverheads: targetConfig.overhead,
      })),
    );

    // update quote signers only if explicitly specified in target config
    // and IGP supports them (detected from on-chain read or version upgrade)
    const offchainFeeQuotingVersion =
      targetConfig.contractVersion ?? currentVersion;
    const supportsOffchainFeeQuoting = igpSupportsOffchainFeeQuoting({
      igpVersion: targetConfig.igpVersion,
      contractVersion: offchainFeeQuotingVersion,
      quoteSigners: currentConfig.quoteSigners,
    });
    if (targetConfig.quoteSigners !== undefined) {
      assert(
        supportsOffchainFeeQuoting,
        `IGP quoteSigners require contract version >= ${OFFCHAIN_QUOTED_IGP_VERSION}`,
      );
      updateTxs.push(
        ...this.updateIgpQuoteSigners({
          currentSigners: currentConfig.quoteSigners ?? [],
          targetSigners: targetConfig.quoteSigners ?? [],
        }),
      );
    }

    // update token gas oracles only if explicitly specified in target config.
    // Gated behind the same support check as quoteSigners: the tokenGasOracles
    // mapping and setTokenGasOracles only exist on the new (non-legacy) IGP.
    const targetTokenOracleConfig = targetConfig.tokenOracleConfig;
    if (
      targetTokenOracleConfig &&
      Object.keys(targetTokenOracleConfig).length > 0
    ) {
      assert(
        supportsOffchainFeeQuoting,
        `IGP tokenOracleConfig requires contract version >= ${OFFCHAIN_QUOTED_IGP_VERSION}`,
      );
      updateTxs.push(
        ...(await this.updateIgpTokenGasOracles({
          interchainGasPaymaster: this.args.addresses.deployedHook,
          targetTokenOracleConfig,
          config: targetConfig,
        })),
      );
    }

    return updateTxs;
  }

  /**
   * Diffs and applies per-fee-token gas oracles on the IGP. Target-driven: the
   * configured fee tokens are the only enumeration source (the on-chain
   * tokenGasOracles mapping is not enumerable), so removals are intentionally
   * unsupported and old fee-token mappings remain live until cleared by a
   * dedicated teardown flow. Each configured token's current oracle is read back
   * from chain, so no off-chain address bookkeeping is needed for additions and
   * updates.
   *
   * For each fee token: resolve the oracle already wired on chain (reused across
   * that token's destinations), or deploy a fresh StorageGasOracle if none is
   * set yet; reconcile the oracle's remote gas data; then point any unmapped
   * destinations at it via setTokenGasOracles.
   */
  protected async updateIgpTokenGasOracles({
    interchainGasPaymaster,
    targetTokenOracleConfig,
    config,
  }: {
    interchainGasPaymaster: Address;
    targetTokenOracleConfig: NonNullable<IgpConfig['tokenOracleConfig']>;
    config: IgpConfig;
  }): Promise<AnnotatedEV5Transaction[]> {
    const updateTxs: AnnotatedEV5Transaction[] = [];
    const igpInterface = InterchainGasPaymaster__factory.createInterface();
    const igp = InterchainGasPaymaster__factory.connect(
      interchainGasPaymaster,
      this.multiProvider.getProvider(this.domainId),
    );
    assertTokenOracleConfigHasNativeRemotes(this.chain, config);

    for (const [feeToken, oracleConfig] of Object.entries(
      targetTokenOracleConfig,
    )) {
      // Resolve the in-MultiProvider remote domains for this fee token.
      const remotes = Object.keys(oracleConfig)
        .map((remote) => ({
          remote,
          domainId: this.multiProvider.tryGetDomainId(remote),
        }))
        .filter(
          (r): r is { remote: string; domainId: number } => r.domainId !== null,
        );

      if (remotes.length === 0) {
        this.logger.warn(
          `Skipping token gas oracle for ${feeToken} on ${this.chain}: no configured remotes in MultiProvider`,
        );
        continue;
      }

      // Find an oracle already wired for this fee token on any configured
      // destination; reuse it across destinations.
      let gasOracle: Address | undefined;
      for (const { domainId } of remotes) {
        const existing = await igp.tokenGasOracles(feeToken, domainId);
        if (!eqAddress(existing, ethers.constants.AddressZero)) {
          gasOracle = existing;
          break;
        }
      }

      // No oracle wired yet -> deploy a dedicated one for this fee token,
      // seeded with its oracle config.
      if (!gasOracle) {
        const newOracle = await this.deployStorageGasOracle({
          config,
          oracleConfig,
        });
        gasOracle = newOracle.address;
      } else {
        // Reconcile remote gas data on the existing oracle. updateStorageGasOracle
        // diffs against a supplied current config, so read it back from chain
        // first (tokenDecimals isn't stored on-chain, so carry it from target to
        // avoid a spurious diff).
        const oracleContract = StorageGasOracle__factory.connect(
          gasOracle,
          this.multiProvider.getProvider(this.domainId),
        );
        const currentOracleConfig: IgpConfig['oracleConfig'] = {};
        for (const { remote, domainId } of remotes) {
          const data = await oracleContract.remoteGasData(domainId);
          currentOracleConfig[remote] = {
            tokenExchangeRate: data.tokenExchangeRate.toString(),
            gasPrice: data.gasPrice.toString(),
            tokenDecimals: oracleConfig[remote]?.tokenDecimals,
          };
        }

        updateTxs.push(
          ...(await this.updateStorageGasOracle({
            gasOracle,
            currentOracleConfig,
            targetOracleConfig: oracleConfig,
            targetOverhead: config.overhead,
          })),
        );
      }

      // Point any destinations not yet mapped to this oracle at it.
      const tokenOracleParams: InterchainGasPaymaster.TokenGasOracleConfigStruct[] =
        [];
      for (const { domainId } of remotes) {
        const current = await igp.tokenGasOracles(feeToken, domainId);
        if (!eqAddress(current, gasOracle)) {
          tokenOracleParams.push({
            feeToken,
            remoteDomain: domainId,
            gasOracle,
          });
        }
      }

      if (tokenOracleParams.length > 0) {
        updateTxs.push({
          annotation: `Setting token gas oracles for ${feeToken} on ${this.chain} (domains ${tokenOracleParams
            .map((p) => p.remoteDomain)
            .join(', ')})`,
          chainId: this.chainId,
          to: interchainGasPaymaster,
          data: igpInterface.encodeFunctionData('setTokenGasOracles', [
            tokenOracleParams,
          ]),
        });
      }
    }

    return updateTxs;
  }

  protected updateIgpQuoteSigners({
    currentSigners,
    targetSigners,
  }: {
    currentSigners: string[];
    targetSigners: string[];
  }): AnnotatedEV5Transaction[] {
    const txs: AnnotatedEV5Transaction[] = [];
    const igpInterface = InterchainGasPaymaster__factory.createInterface();

    const currentSet = new Set(currentSigners.map((s) => s.toLowerCase()));
    const targetSet = new Set(targetSigners.map((s) => s.toLowerCase()));

    for (const signer of difference(targetSet, currentSet)) {
      txs.push({
        annotation: `Add IGP quote signer ${signer}`,
        chainId: this.chainId,
        to: this.args.addresses.deployedHook,
        data: igpInterface.encodeFunctionData('addQuoteSigner', [signer]),
      });
    }

    for (const signer of difference(currentSet, targetSet)) {
      txs.push({
        annotation: `Remove IGP quote signer ${signer}`,
        chainId: this.chainId,
        to: this.args.addresses.deployedHook,
        data: igpInterface.encodeFunctionData('removeQuoteSigner', [signer]),
      });
    }

    return txs;
  }

  protected async updateIgpRemoteGasParams({
    interchainGasPaymaster,
    gasOracle,
    currentOverheads,
    targetOverheads,
  }: {
    interchainGasPaymaster: Address;
    gasOracle: Address;
    currentOverheads?: IgpConfig['overhead'];
    targetOverheads: IgpConfig['overhead'];
  }): Promise<AnnotatedEV5Transaction[]> {
    const gasParamsToSet: InterchainGasPaymaster.GasParamStruct[] = [];
    for (const [remote, gasOverhead] of Object.entries(targetOverheads)) {
      // Note: non-EVM remotes actually *are* supported, provided that the remote domain is in the MultiProvider.
      // Previously would check core metadata for non EVMs and fallback to multiprovider for custom EVMs
      const remoteDomain = this.multiProvider.tryGetDomainId(remote);

      if (!remoteDomain) {
        this.logger.warn(
          `Skipping overhead ${this.chain} -> ${remote}. Expected if the remote domain is not in the MultiProvider.`,
        );
        continue;
      }

      // only update if the gas overhead has changed
      if (currentOverheads?.[remote] !== gasOverhead) {
        this.logger.debug(
          `Setting gas params for ${this.chain} -> ${remote}: gasOverhead = ${gasOverhead} gasOracle = ${gasOracle}`,
        );
        gasParamsToSet.push({
          remoteDomain,
          config: {
            gasOverhead,
            gasOracle,
          },
        });
      }
    }

    if (gasParamsToSet.length === 0) {
      return [];
    }

    return [
      {
        annotation: `Updating overhead for domains ${Object.keys(
          targetOverheads,
        ).join(', ')}...`,
        chainId: this.chainId,
        to: interchainGasPaymaster,
        data: InterchainGasPaymaster__factory.createInterface().encodeFunctionData(
          'setDestinationGasConfigs((uint32,(address,uint96))[])',
          [gasParamsToSet],
        ),
      },
    ];
  }

  protected async updateStorageGasOracle({
    gasOracle,
    currentOracleConfig,
    targetOracleConfig,
    targetOverhead,
  }: {
    gasOracle: Address;
    currentOracleConfig?: IgpConfig['oracleConfig'];
    targetOracleConfig: IgpConfig['oracleConfig'];
    targetOverhead: IgpConfig['overhead'];
  }): Promise<AnnotatedEV5Transaction[]> {
    this.logger.info(`Updating gas oracle configuration from ${this.chain}...`);
    const configsToSet: Array<StorageGasOracle.RemoteGasDataConfigStruct> = [];

    for (const [remote, target] of Object.entries(targetOracleConfig)) {
      // Note: non-EVM remotes actually *are* supported, provided that the remote domain is in the MultiProvider.
      // Previously would check core metadata for non EVMs and fallback to multiprovider for custom EVMs
      const current = currentOracleConfig?.[remote];
      const remoteDomain = this.multiProvider.tryGetDomainId(remote);

      if (!remoteDomain) {
        this.logger.warn(
          `Skipping gas oracle update ${this.chain} -> ${remote}. Expected if the remote domain is not in the MultiProvider.`,
        );
        continue;
      }

      // only update if the oracle config has changed
      const comparableTarget = {
        gasPrice: target.gasPrice,
        tokenExchangeRate: target.tokenExchangeRate,
        tokenDecimals: target.tokenDecimals,
      };
      if (!current || !deepEquals(current, comparableTarget)) {
        configsToSet.push({ remoteDomain, ...target });

        // Log an example remote gas cost
        const exampleRemoteGas = (targetOverhead[remote] ?? 200_000) + 50_000;
        const exampleRemoteGasCost = BigNumber.from(target.tokenExchangeRate)
          .mul(target.gasPrice)
          .mul(exampleRemoteGas)
          .div(TOKEN_EXCHANGE_RATE_SCALE_ETHEREUM);
        this.logger.info(
          `${
            this.chain
          } -> ${remote}: ${exampleRemoteGas} remote gas cost: ${ethers.utils.formatEther(
            exampleRemoteGasCost,
          )}`,
        );
      }
    }

    if (configsToSet.length === 0) {
      return [];
    }

    return [
      {
        annotation: `Updating gas oracle config for domains ${Object.keys(
          targetOracleConfig,
        ).join(', ')}...`,
        chainId: this.chainId,
        to: gasOracle,
        data: StorageGasOracle__factory.createInterface().encodeFunctionData(
          'setRemoteGasDataConfigs((uint32,uint128,uint128)[])',
          [configsToSet],
        ),
      },
    ];
  }

  protected async updateProtocolFeeHook({
    currentConfig,
    targetConfig,
  }: {
    currentConfig: ProtocolFeeHookConfig;
    targetConfig: ProtocolFeeHookConfig;
  }): Promise<AnnotatedEV5Transaction[]> {
    const updateTxs: AnnotatedEV5Transaction[] = [];
    const protocolFeeInterface = ProtocolFee__factory.createInterface();

    // if maxProtocolFee has changed, deploy a new hook
    if (currentConfig.maxProtocolFee !== targetConfig.maxProtocolFee) {
      const hook = await this.deployProtocolFeeHook({ config: targetConfig });
      this.args.addresses.deployedHook = hook.address;
      return [];
    }

    // Update protocol fee if changed
    if (currentConfig.protocolFee !== targetConfig.protocolFee) {
      updateTxs.push({
        annotation: `Updating protocol fee from ${currentConfig.protocolFee} to ${targetConfig.protocolFee}`,
        chainId: this.chainId,
        to: this.args.addresses.deployedHook,
        data: protocolFeeInterface.encodeFunctionData(
          'setProtocolFee(uint256)',
          [targetConfig.protocolFee],
        ),
      });
    }

    // Update beneficiary if changed
    if (currentConfig.beneficiary !== targetConfig.beneficiary) {
      updateTxs.push({
        annotation: `Updating beneficiary from ${currentConfig.beneficiary} to ${targetConfig.beneficiary}`,
        chainId: this.chainId,
        to: this.args.addresses.deployedHook,
        data: protocolFeeInterface.encodeFunctionData(
          'setBeneficiary(address)',
          [targetConfig.beneficiary],
        ),
      });
    }

    // Return the transactions to update the protocol fee hook
    return updateTxs;
  }

  // Updates a routing hook
  protected async updateRoutingHook({
    currentConfig,
    targetConfig,
  }: {
    currentConfig: DomainRoutingHookConfig | FallbackRoutingHookConfig;
    targetConfig: DomainRoutingHookConfig | FallbackRoutingHookConfig;
  }): Promise<AnnotatedEV5Transaction[]> {
    // Deploy a new fallback hook if the fallback config has changed
    if (
      targetConfig.type === HookType.FALLBACK_ROUTING &&
      !hookConfigsEqual(
        targetConfig.fallback,
        (currentConfig as FallbackRoutingHookConfig).fallback,
      )
    ) {
      const hook = await this.deploy({ config: targetConfig });
      this.args.addresses.deployedHook = hook.address;
      return [];
    }

    const routingUpdates = await this.computeRoutingHooksToSet({
      currentDomains: currentConfig.domains,
      targetDomains: targetConfig.domains,
    });

    // Return if no updates are required
    if (routingUpdates.length === 0) {
      return [];
    }

    // Create tx for setting hooks
    return [
      {
        annotation: 'Updating routing hooks...',
        chainId: this.chainId,
        to: this.args.addresses.deployedHook,
        data: DomainRoutingHook__factory.createInterface().encodeFunctionData(
          'setHooks((uint32,address)[])',
          [routingUpdates],
        ),
      },
    ];
  }

  protected async deploy({
    config,
  }: {
    config: HookConfig;
  }): Promise<DeployedHook> {
    config = HookConfigSchema.parse(config);

    // If it's an address, just return a base Hook
    if (typeof config === 'string') {
      // TODO: https://github.com/hyperlane-xyz/hyperlane-monorepo/issues/3773
      // we can remove the ts-ignore once we have a proper type for address Hooks
      // @ts-ignore
      return IPostDispatchHook__factory.connect(
        config,
        this.multiProvider.getSignerOrProvider(this.args.chain),
      );
    }

    this.logger.debug(`Deploying hook of type ${config.type}`);

    switch (config.type) {
      case HookType.MERKLE_TREE:
      case HookType.MAILBOX_DEFAULT:
        return this.deployer.deployContract(this.chain, config.type, [
          this.args.addresses.mailbox,
        ]);
      case HookType.INTERCHAIN_GAS_PAYMASTER:
        return this.deployIgpHook({ config });
      case HookType.AGGREGATION:
        return this.deployAggregationHook({ config });
      case HookType.PROTOCOL_FEE:
        return this.deployProtocolFeeHook({ config });
      case HookType.OP_STACK:
        return this.deployOpStackHook({ config });
      case HookType.ARB_L2_TO_L1:
        return this.deployArbL1ToL1Hook({ config });
      case HookType.ROUTING:
      case HookType.FALLBACK_ROUTING:
        return this.deployRoutingHook({ config });
      case HookType.PAUSABLE:
        return this.deployPausableHook({ config });
      case HookType.AMOUNT_ROUTING:
        return this.deployAmountRoutingHook({ config });
      case HookType.CCIP:
        return this.deployCCIPHook({ config });
      case HookType.CCTP:
        // TODO: https://github.com/hyperlane-xyz/hyperlane-monorepo/issues/3773
        // we can remove the ts-ignore once we have a proper type for address Hooks
        // @ts-ignore
        return IPostDispatchHook__factory.connect(
          config.address,
          this.multiProvider.getSignerOrProvider(this.args.chain),
        );
      case HookType.RATE_LIMITED:
        return this.deployRateLimitedHook({ config });
      case HookType.NET_FLOW_RATE_LIMITED:
      case HookType.DELAYED_FLOW_ROUTER:
        throw new Error(
          `${config.type} is a hook/ISM hybrid deployed via its ISM config ` +
            `(HyperlaneIsmFactory); reference the deployed instance by address as the hook`,
        );
      default:
        throw new Error(`Unsupported hook config: ${config}`);
    }
  }

  protected async deployProtocolFeeHook({
    config,
  }: {
    config: ProtocolFeeHookConfig;
  }): Promise<ProtocolFee> {
    this.logger.debug('Deploying ProtocolFeeHook...');
    const deployer = new HookDeployer(this.multiProvider, hookFactories);
    return deployer.deployContract(this.chain, HookType.PROTOCOL_FEE, [
      config.maxProtocolFee,
      config.protocolFee,
      config.beneficiary,
      config.owner,
    ]);
  }

  protected async deployPausableHook({
    config,
  }: {
    config: PausableHookConfig;
  }): Promise<PausableHook> {
    this.logger.debug('Deploying PausableHook...');
    const deployer = new HookDeployer(this.multiProvider, hookFactories);
    const hook = await deployer.deployContract(
      this.chain,
      HookType.PAUSABLE,
      [],
    );

    if (config.paused) {
      await this.multiProvider.handleTx(
        this.chain,
        hook.pause(this.txOverrides),
      );
    }

    // transfer ownership
    await this.multiProvider.handleTx(
      this.chain,
      hook.transferOwnership(config.owner, this.txOverrides),
    );

    return hook;
  }

  protected async deployRateLimitedHook({
    config,
  }: {
    config: RateLimitedHookConfig;
  }): Promise<RateLimitedHook> {
    this.logger.debug('Deploying RateLimitedHook...');
    const deployer = new HookDeployer(this.multiProvider, hookFactories);
    const sender = this.args.addresses.rateLimitedSender;
    assert(sender, 'rateLimitedSender is required to deploy RateLimitedHook');
    const hook = await deployer.deployContract(
      this.chain,
      HookType.RATE_LIMITED,
      [
        this.args.addresses.mailbox,
        config.maxCapacity,
        config.duration,
        sender,
      ],
    );

    if (config.owner) {
      await this.multiProvider.handleTx(
        this.chain,
        hook.transferOwnership(config.owner, this.txOverrides),
      );
    }

    return hook;
  }

  protected async deployAggregationHook({
    config,
  }: {
    config: AggregationHookConfig;
  }): Promise<StaticAggregationHook> {
    this.logger.debug('Deploying AggregationHook...');

    // deploy subhooks
    const aggregatedHooks: string[] = [];
    for (const hookConfig of config.hooks) {
      const { address } = await this.deploy({ config: hookConfig });
      aggregatedHooks.push(address);
    }

    // deploy aggregation hook
    this.logger.debug(
      `Deploying aggregation hook of type ${config.hooks.map((h) =>
        typeof h === 'string' ? h : h.type,
      )}...`,
    );
    const signer = this.multiProvider.getSigner(this.chain);
    const factory = StaticAggregationHookFactory__factory.connect(
      this.args.addresses.staticAggregationHookFactory,
      signer,
    );
    const address = await this.hookFactory.deployStaticAddressSet(
      this.chain,
      factory,
      aggregatedHooks,
      this.logger,
    );

    // return aggregation hook
    return StaticAggregationHook__factory.connect(address, signer);
  }

  // NOTE: this deploys the ism too on the destination chain if it doesn't exist
  protected async deployOpStackHook({
    config,
  }: {
    config: OpStackHookConfig;
  }): Promise<OPStackHook> {
    const chain = this.chain;
    const mailbox = this.args.addresses.mailbox;
    this.logger.debug(
      'Deploying OPStackHook for %s to %s...',
      chain,
      config.destinationChain,
    );

    // fetch l2 messenger address from l1 messenger
    const l1Messenger = IL1CrossDomainMessenger__factory.connect(
      config.nativeBridge,
      this.multiProvider.getSignerOrProvider(chain),
    );
    const l2Messenger: Address = await l1Messenger.OTHER_MESSENGER();
    // deploy opstack ism
    const ismConfig: OpStackIsmConfig = {
      type: IsmType.OP_STACK,
      origin: chain,
      nativeBridge: l2Messenger,
    };

    // deploy opstack ism
    const opStackIsmAddress = (
      await EvmIsmModule.create({
        chain: config.destinationChain,
        config: ismConfig,
        proxyFactoryFactories: this.args.addresses,
        mailbox: mailbox,
        multiProvider: this.multiProvider,
        contractVerifier: this.contractVerifier,
      })
    ).serialize().deployedIsm;

    // connect to ISM
    const opstackIsm = OPStackIsm__factory.connect(
      opStackIsmAddress,
      this.multiProvider.getSignerOrProvider(config.destinationChain),
    );

    // deploy opstack hook
    const hook = await this.deployer.deployContract(chain, HookType.OP_STACK, [
      mailbox,
      this.multiProvider.getDomainId(config.destinationChain),
      addressToBytes32(opstackIsm.address),
      config.nativeBridge,
    ]);

    // set authorized hook on opstack ism
    const authorizedHook = await opstackIsm.authorizedHook();
    if (authorizedHook === addressToBytes32(hook.address)) {
      this.logger.debug(
        'Authorized hook already set on ism %s',
        opstackIsm.address,
      );
      return hook;
    } else if (authorizedHook !== ZERO_ADDRESS_HEX_32) {
      this.logger.debug(
        'Authorized hook mismatch on ism %s, expected %s, got %s',
        opstackIsm.address,
        addressToBytes32(hook.address),
        authorizedHook,
      );
      throw new Error('Authorized hook mismatch');
    }

    // check if mismatch and redeploy hook
    this.logger.debug(
      'Setting authorized hook %s on ism % on destination %s',
      hook.address,
      opstackIsm.address,
      config.destinationChain,
    );
    await this.multiProvider.handleTx(
      config.destinationChain,
      opstackIsm.setAuthorizedHook(
        addressToBytes32(hook.address),
        this.multiProvider.getTransactionOverrides(config.destinationChain),
      ),
    );

    return hook;
  }

  // NOTE: this deploys the ism too on the destination chain if it doesn't exist
  protected async deployArbL1ToL1Hook({
    config,
  }: {
    config: ArbL2ToL1HookConfig;
  }): Promise<ArbL2ToL1Hook> {
    const chain = this.chain;
    const mailbox = this.args.addresses.mailbox;

    const destinationChainId = this.multiProvider.tryGetEvmChainId(
      config.destinationChain,
    );
    if (!destinationChainId) {
      throw new Error(
        `Only ethereum chains supported for deploying Arbitrum L2 hook, given: ${config.destinationChain}`,
      );
    }

    const bridge =
      config.bridge ?? getArbitrumNetwork(destinationChainId).ethBridge.bridge;

    const ismConfig: ArbL2ToL1IsmConfig = {
      type: IsmType.ARB_L2_TO_L1,
      bridge,
    };

    const arbL2ToL1IsmAddress = (
      await EvmIsmModule.create({
        chain: config.destinationChain,
        config: ismConfig,
        proxyFactoryFactories: this.args.addresses,
        mailbox: mailbox,
        multiProvider: this.multiProvider,
        contractVerifier: this.contractVerifier,
      })
    ).serialize().deployedIsm;

    // connect to ISM
    const arbL2ToL1Ism = ArbL2ToL1Ism__factory.connect(
      arbL2ToL1IsmAddress,
      this.multiProvider.getSignerOrProvider(config.destinationChain),
    );

    const childHook = await this.deploy({ config: config.childHook });

    // deploy arbL1ToL1 hook
    const hook = await this.deployer.deployContract(
      chain,
      HookType.ARB_L2_TO_L1,
      [
        mailbox,
        this.multiProvider.getDomainId(config.destinationChain),
        addressToBytes32(arbL2ToL1IsmAddress),
        config.arbSys,
        childHook.address,
      ],
    );
    // set authorized hook on arbL2ToL1 ism
    const authorizedHook = await arbL2ToL1Ism.authorizedHook();
    if (authorizedHook === addressToBytes32(hook.address)) {
      this.logger.debug(
        'Authorized hook already set on ism %s',
        arbL2ToL1Ism.address,
      );
      return hook;
    } else if (authorizedHook !== ethers.constants.HashZero) {
      this.logger.debug(
        'Authorized hook mismatch on ism %s, expected %s, got %s',
        arbL2ToL1Ism.address,
        addressToBytes32(hook.address),
        authorizedHook,
      );
      throw new Error('Authorized hook mismatch');
    }

    // check if mismatch and redeploy hook
    this.logger.debug(
      'Setting authorized hook %s on ism % on destination %s',
      hook.address,
      arbL2ToL1Ism.address,
      config.destinationChain,
    );
    await this.multiProvider.handleTx(
      config.destinationChain,
      arbL2ToL1Ism.setAuthorizedHook(
        addressToBytes32(hook.address),
        this.multiProvider.getTransactionOverrides(config.destinationChain),
      ),
    );

    return hook;
  }

  protected async deployCCIPHook({
    config,
  }: {
    config: CCIPHookConfig;
  }): Promise<CCIPHook> {
    const hook = this.hookFactory.ccipContractCache.getHook(
      this.chain,
      config.destinationChain,
    );
    if (!hook) {
      this.logger.error(
        `CCIP Hook not found for ${this.chain} -> ${config.destinationChain}`,
      );
      throw new Error(
        `CCIP Hook not found for ${this.chain} -> ${config.destinationChain}`,
      );
    }
    return CCIPHook__factory.connect(
      hook,
      this.multiProvider.getSigner(this.chain),
    );
  }

  protected async deployRoutingHook({
    config,
  }: {
    config: DomainRoutingHookConfig | FallbackRoutingHookConfig;
  }): Promise<DomainRoutingHook> {
    // originally set owner to deployer so we can set hooks
    const deployerAddress = await this.multiProvider.getSignerAddress(
      this.chain,
    );

    let routingHook: DomainRoutingHook | FallbackDomainRoutingHook;
    if (config.type === HookType.FALLBACK_ROUTING) {
      // deploy fallback hook
      const fallbackHook = await this.deploy({ config: config.fallback });
      // deploy routing hook with fallback
      routingHook = await this.deployer.deployContractWithName(
        this.chain,
        HookType.FALLBACK_ROUTING,
        HookTypeToContractNameMap[HookType.FALLBACK_ROUTING],
        [this.args.addresses.mailbox, deployerAddress, fallbackHook.address],
      );
    } else {
      // deploy routing hook
      routingHook = await this.deployer.deployContract(
        this.chain,
        HookType.ROUTING,
        [this.args.addresses.mailbox, deployerAddress],
      );
    }

    // compute the hooks that need to be set
    const hooksToSet = await this.computeRoutingHooksToSet({
      currentDomains: {},
      targetDomains: config.domains,
    });

    // set hooks
    await this.multiProvider.handleTx(
      this.chain,
      routingHook.setHooks(hooksToSet, this.txOverrides),
    );

    // transfer ownership
    await this.multiProvider.handleTx(
      this.chain,
      routingHook.transferOwnership(config.owner, this.txOverrides),
    );

    // return a fully configured routing hook
    return routingHook;
  }

  protected async deployIgpHook({
    config,
  }: {
    config: IgpHookConfig;
  }): Promise<InterchainGasPaymaster> {
    assert(
      config.igpVersion !== IgpVersion.Legacy,
      'Legacy IGP configs require an existing deployment and cannot deploy a new IGP',
    );

    this.logger.debug('Deploying IGP as hook...');

    // Deploy the StorageGasOracle
    const storageGasOracle = await this.deployStorageGasOracle({
      config,
    });

    // Deploy the InterchainGasPaymaster (handles token gas oracle wiring
    // via updateIgpTokenGasOracles before transferring ownership)
    const interchainGasPaymaster = await this.deployInterchainGasPaymaster({
      storageGasOracle,
      config,
    });

    return interchainGasPaymaster;
  }

  protected async deployInterchainGasPaymaster({
    storageGasOracle,
    config,
  }: {
    storageGasOracle: StorageGasOracle;
    config: IgpConfig;
  }): Promise<InterchainGasPaymaster> {
    // Set the deployer as the owner of the IGP for configuration purposes
    const deployerAddress = await this.multiProvider.getSignerAddress(
      this.chain,
    );

    // Deploy the InterchainGasPaymaster
    const igp = await this.deployer.deployProxiedContract(
      this.chain,
      HookType.INTERCHAIN_GAS_PAYMASTER,
      HookType.INTERCHAIN_GAS_PAYMASTER,
      this.args.addresses.proxyAdmin,
      [],
      [deployerAddress, config.beneficiary],
    );

    // Obtain the transactions to set the gas params for each remote
    const configureTxs = await this.updateIgpRemoteGasParams({
      interchainGasPaymaster: igp.address,
      gasOracle: storageGasOracle.address,
      targetOverheads: config.overhead,
    });

    // Set the gas params for each remote
    for (const tx of configureTxs) {
      await this.multiProvider.sendTransaction(this.chain, tx);
    }

    // Add quote signers if configured
    if (config.quoteSigners?.length) {
      for (const signer of config.quoteSigners) {
        await this.multiProvider.handleTx(
          this.chain,
          igp.addQuoteSigner(signer, this.txOverrides),
        );
      }
    }

    // Wire per-fee-token gas oracles if configured. Must run while the deployer
    // still owns the IGP (setTokenGasOracles is onlyOwner) and after the native
    // gas params above, since the IGP requires a destination's native oracle to
    // exist before a non-native token oracle can be set for it.
    if (config.tokenOracleConfig !== undefined) {
      const tokenOracleTxs = await this.updateIgpTokenGasOracles({
        interchainGasPaymaster: igp.address,
        targetTokenOracleConfig: config.tokenOracleConfig,
        config,
      });
      for (const tx of tokenOracleTxs) {
        await this.multiProvider.sendTransaction(this.chain, tx);
      }
    }

    // Transfer igp to the configured owner
    await this.multiProvider.handleTx(
      this.chain,
      igp.transferOwnership(config.owner, this.txOverrides),
    );

    return igp;
  }

  protected async deployAmountRoutingHook({
    config,
  }: {
    config: AmountRoutingHookConfig;
  }): Promise<AmountRoutingHook> {
    const hooks = [];
    for (const hookConfig of [config.lowerHook, config.upperHook]) {
      const { address } = await this.deploy({ config: hookConfig });
      hooks.push(address);
    }

    const [lowerHook, upperHook] = hooks;

    // deploy routing hook
    const routingHook = await this.deployer.deployContract(
      this.chain,
      HookType.AMOUNT_ROUTING,
      [lowerHook, upperHook, config.threshold],
    );

    return routingHook;
  }

  protected async deployStorageGasOracle({
    config,
    oracleConfig = config.oracleConfig,
  }: {
    config: IgpConfig;
    // Oracle data to seed the deployed oracle with. Defaults to the native
    // oracleConfig; token gas oracles pass their per-fee-token config instead.
    oracleConfig?: IgpConfig['oracleConfig'];
  }): Promise<StorageGasOracle> {
    // Deploy the StorageGasOracle, by default msg.sender is the owner
    const gasOracle = await this.deployer.deployContractFromFactory(
      this.chain,
      new StorageGasOracle__factory(),
      'storageGasOracle',
      [],
    );

    // Obtain the transactions to set the gas params for each remote
    const configureTxs = await this.updateStorageGasOracle({
      gasOracle: gasOracle.address,
      targetOracleConfig: oracleConfig,
      targetOverhead: config.overhead,
    });

    // Set the gas params for each remote
    for (const tx of configureTxs) {
      await this.multiProvider.sendTransaction(this.chain, tx);
    }

    // Transfer gas oracle to the configured owner
    await this.multiProvider.handleTx(
      this.chain,
      gasOracle.transferOwnership(config.oracleKey, this.txOverrides),
    );

    return gasOracle;
  }
}
