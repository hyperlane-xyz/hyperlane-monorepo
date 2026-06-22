import { ethers } from 'ethers';

import {
  AmountRoutingHook__factory,
  ArbL2ToL1Hook__factory,
  CCIPHook__factory,
  DefaultHook__factory,
  DomainRoutingHook,
  DomainRoutingHook__factory,
  FallbackDomainRoutingHook,
  FallbackDomainRoutingHook__factory,
  IPostDispatchHook__factory,
  InterchainGasPaymaster__factory,
  MerkleTreeHook__factory,
  OPStackHook__factory,
  PausableHook__factory,
  ProtocolFee__factory,
  RateLimitedHook__factory,
  StaticAggregationHook__factory,
  StorageGasOracle__factory,
} from '@hyperlane-xyz/core';
import {
  Address,
  WithAddress,
  assert,
  concurrentMap,
  eqAddress,
  getLogLevel,
  isZeroishAddress,
  objMap,
  promiseObjAll,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { DEFAULT_CONTRACT_READ_CONCURRENCY } from '../consts/concurrency.js';
import { DispatchedMessage } from '../core/types.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { ChainNameOrId } from '../types.js';
import { HyperlaneReader } from '../utils/HyperlaneReader.js';
import {
  isMissingSelectorCallException,
  throwIfNotMissingSelector,
  throwIfNotMissingSelectorRevert,
} from '../utils/contract.js';

import {
  AggregationHookConfig,
  AmountRoutingHookConfig,
  ArbL2ToL1HookConfig,
  CCIPHookConfig,
  DerivedHookConfig,
  DomainRoutingHookConfig,
  FallbackRoutingHookConfig,
  HookConfig,
  HookType,
  IgpVersion,
  IgpHookConfig,
  MailboxDefaultHookConfig,
  MerkleTreeHookConfig,
  OnchainHookType,
  OpStackHookConfig,
  PausableHookConfig,
  ProtocolFeeHookConfig,
  RateLimitedHookConfig,
  RoutingHookConfig,
} from './types.js';

function isUnsupportedIgpDomainError(
  error: unknown,
  domainId: number,
): boolean {
  // Mirrors InterchainGasPaymaster.getExchangeRateAndGasPrice in
  // solidity/contracts/hooks/igp/InterchainGasPaymaster.sol.
  return (
    error instanceof Error &&
    error.message.includes(`Configured IGP doesn't support domain ${domainId}`)
  );
}

export interface HookReader {
  deriveHookConfig(address: HookConfig): Promise<WithAddress<HookConfig>>;
  deriveMerkleTreeConfig(
    address: Address,
  ): Promise<WithAddress<MerkleTreeHookConfig>>;
  deriveAggregationConfig(
    address: Address,
  ): Promise<WithAddress<AggregationHookConfig>>;
  deriveIgpConfig(address: Address): Promise<WithAddress<IgpHookConfig>>;
  deriveProtocolFeeConfig(
    address: Address,
  ): Promise<WithAddress<ProtocolFeeHookConfig>>;
  deriveOpStackConfig(
    address: Address,
  ): Promise<WithAddress<OpStackHookConfig>>;
  deriveArbL2ToL1Config(
    address: Address,
  ): Promise<WithAddress<ArbL2ToL1HookConfig>>;
  deriveDomainRoutingConfig(
    address: Address,
  ): Promise<WithAddress<DomainRoutingHookConfig>>;
  deriveFallbackRoutingConfig(
    address: Address,
  ): Promise<WithAddress<FallbackRoutingHookConfig>>;
  derivePausableConfig(
    address: Address,
  ): Promise<WithAddress<PausableHookConfig>>;
  deriveIdAuthIsmConfig(address: Address): Promise<DerivedHookConfig>;
  deriveCcipConfig(address: Address): Promise<WithAddress<CCIPHookConfig>>;
  deriveRateLimitedHookConfig(
    address: Address,
  ): Promise<WithAddress<RateLimitedHookConfig>>;
  assertHookType(
    hookType: OnchainHookType,
    expectedType: OnchainHookType,
  ): void;
}

export class EvmHookReader extends HyperlaneReader implements HookReader {
  protected readonly logger = rootLogger.child({ module: 'EvmHookReader' });
  /**
   * HookConfig cache for already retrieved configs. Useful to avoid recomputing configs
   * when they have already been retrieved in previous calls where `deriveHookConfig` was called by
   * the specific hook methods.
   */
  private _cache: Map<Address, any> = new Map();

  constructor(
    protected readonly multiProvider: MultiProvider,
    protected readonly chain: ChainNameOrId,
    protected readonly concurrency: number = multiProvider.tryGetRpcConcurrency(
      chain,
    ) ?? DEFAULT_CONTRACT_READ_CONCURRENCY,
    protected readonly messageContext?: DispatchedMessage,
  ) {
    super(multiProvider, chain);
  }

  async deriveHookConfigFromAddress(
    address: Address,
  ): Promise<DerivedHookConfig> {
    this.logger.debug('Deriving HookConfig:', { address });

    const cachedValue = this._cache.get(address);
    if (cachedValue) {
      this.logger.debug(
        `Cache hit for HookConfig on chain ${this.chain} at: ${address}`,
      );
      return cachedValue;
    }

    this.logger.debug(
      `Cache miss for HookConfig on chain ${this.chain} at: ${address}`,
    );

    let onchainHookType: OnchainHookType | undefined = undefined;
    let derivedHookConfig: DerivedHookConfig;

    try {
      const hook = IPostDispatchHook__factory.connect(address, this.provider);
      this.logger.debug('Deriving HookConfig:', { address });

      // Temporarily turn off SmartProvider logging
      // Provider errors are expected because deriving will call methods that may not exist in the Bytecode
      this.setSmartProviderLogLevel('silent');
      onchainHookType = await hook.hookType();

      switch (onchainHookType) {
        case OnchainHookType.ROUTING:
          derivedHookConfig = await this.deriveDomainRoutingConfig(address);
          break;
        case OnchainHookType.AGGREGATION:
          derivedHookConfig = await this.deriveAggregationConfig(address);
          break;
        case OnchainHookType.MERKLE_TREE:
          derivedHookConfig = await this.deriveMerkleTreeConfig(address);
          break;
        case OnchainHookType.INTERCHAIN_GAS_PAYMASTER:
          derivedHookConfig = await this.deriveIgpConfig(address);
          break;
        case OnchainHookType.FALLBACK_ROUTING:
          derivedHookConfig = await this.deriveFallbackRoutingConfig(address);
          break;
        case OnchainHookType.PAUSABLE:
          derivedHookConfig = await this.derivePausableConfig(address);
          break;
        case OnchainHookType.PROTOCOL_FEE:
          derivedHookConfig = await this.deriveProtocolFeeConfig(address);
          break;
        case OnchainHookType.ID_AUTH_ISM:
          derivedHookConfig = await this.deriveIdAuthIsmConfig(address);
          break;
        case OnchainHookType.ARB_L2_TO_L1:
          derivedHookConfig = await this.deriveArbL2ToL1Config(address);
          break;
        case OnchainHookType.AMOUNT_ROUTING:
          derivedHookConfig = await this.deriveAmountRoutingHookConfig(address);
          break;
        case OnchainHookType.MAILBOX_DEFAULT_HOOK:
          derivedHookConfig =
            await this.deriveMailboxDefaultHookConfig(address);
          break;
        case OnchainHookType.PREDICATE_ROUTER_WRAPPER:
          derivedHookConfig = { type: HookType.PREDICATE, address };
          this._cache.set(address, derivedHookConfig);
          break;
        case OnchainHookType.CCTP:
          derivedHookConfig = { type: HookType.CCTP, address };
          this._cache.set(address, derivedHookConfig);
          break;
        case OnchainHookType.RATE_LIMITED:
          derivedHookConfig = await this.deriveRateLimitedHookConfig(address);
          break;
        default:
          throw new Error(
            `Unsupported HookType: ${OnchainHookType[onchainHookType]}`,
          );
      }
    } catch (e) {
      let customMessage: string = `Failed to derive ${onchainHookType} hook (${address})`;
      if (!onchainHookType && isMissingSelectorCallException(e)) {
        this.logger.info(
          `Hook at ${address} does not support hookType() — treating as unknown hook:\n\t${e}`,
        );
        return { type: HookType.UNKNOWN, address } as DerivedHookConfig;
      } else {
        this.logger.debug(`${customMessage}:\n\t${e}`);
      }
      throw new Error(`${customMessage}:\n\t${e}`);
    } finally {
      this.setSmartProviderLogLevel(getLogLevel()); // returns to original level defined by rootLogger
    }

    return derivedHookConfig;
  }

  /**
   *  Recursively resolves the HookConfigs as addresses, e.g.
   *  hook:
   *     type: aggregationHook
   *     hooks:
   *       - "0x7937CB2886f01F38210506491A69B0D107Ea0ad9"
   *       - beneficiary: "0x865BA5789D82F2D4C5595a3968dad729A8C3daE6"
   *         maxProtocolFee: "100000000000000000000"
   *         owner: "0x865BA5789D82F2D4C5595a3968dad729A8C3daE6"
   *         protocolFee: "50000000000000000"
   *         type: protocolFee
   *
   * This may throw if the Hook address is not a derivable hook (e.g. Custom Hook)
   */
  public async deriveHookConfig(
    config: HookConfig,
  ): Promise<DerivedHookConfig> {
    if (typeof config === 'string')
      return this.deriveHookConfigFromAddress(config);

    // Extend the inner hooks
    switch (config.type) {
      case HookType.FALLBACK_ROUTING:
      case HookType.ROUTING:
        config.domains = await promiseObjAll(
          objMap(config.domains, async (_, hook) => {
            const derived = await this.deriveHookConfig(hook);
            return this.preserveUnredeployable(hook, derived);
          }),
        );

        if (config.type === HookType.FALLBACK_ROUTING) {
          const derived = await this.deriveHookConfig(config.fallback);
          config.fallback = this.preserveUnredeployable(
            config.fallback,
            derived,
          );
        }
        break;
      case HookType.CCTP:
        return config;
      case HookType.AGGREGATION:
        config.hooks = await Promise.all(
          config.hooks.map(async (hook) => {
            const derived = await this.deriveHookConfig(hook);
            return this.preserveUnredeployable(hook, derived);
          }),
        );
        break;
      case HookType.AMOUNT_ROUTING: {
        const lowerOrig = config.lowerHook;
        const upperOrig = config.upperHook;
        const [lowerDerived, upperDerived] = await Promise.all([
          this.deriveHookConfig(lowerOrig),
          this.deriveHookConfig(upperOrig),
        ]);
        config.lowerHook = this.preserveUnredeployable(lowerOrig, lowerDerived);
        config.upperHook = this.preserveUnredeployable(upperOrig, upperDerived);
        break;
      }
    }
    return config as DerivedHookConfig;
  }

  // Returns original HookConfig for non-redeployable types (CCTP, PREDICATE) so that
  // normalizeConfig — which strips 'address' from all objects — does not discard
  // the address. Returns the address as a bare string so it survives normalizeConfig
  // and deploy() reaches the string branch intact, regardless of whether the original
  // was already a string or an object with an address field.
  private preserveUnredeployable(
    original: HookConfig,
    derived: DerivedHookConfig,
  ): HookConfig {
    if (derived.type !== HookType.CCTP && derived.type !== HookType.PREDICATE) {
      return derived;
    }
    if (typeof original === 'string') return original;
    return derived.address;
  }

  async deriveMailboxDefaultHookConfig(
    address: Address,
  ): Promise<WithAddress<MailboxDefaultHookConfig>> {
    const hook = DefaultHook__factory.connect(address, this.provider);
    this.assertHookType(
      await hook.hookType(),
      OnchainHookType.MAILBOX_DEFAULT_HOOK,
    );

    const config: WithAddress<MailboxDefaultHookConfig> = {
      address,
      type: HookType.MAILBOX_DEFAULT,
    };

    this._cache.set(address, config);

    return config;
  }

  async deriveIdAuthIsmConfig(address: Address): Promise<DerivedHookConfig> {
    // First check if it's a CCIP hook
    const ccipHook = CCIPHook__factory.connect(address, this.provider);
    try {
      // This method only exists on CCIPHook
      await ccipHook.ccipDestination();
    } catch (error) {
      throwIfNotMissingSelector(error);

      // Not a CCIP hook, try OPStack
      const opStackHook = OPStackHook__factory.connect(address, this.provider);
      try {
        // This method only exists on OPStackHook
        await opStackHook.l1Messenger();
      } catch (innerError) {
        throwIfNotMissingSelector(innerError);
        throw new Error(
          `Could not determine hook type - neither CCIP nor OPStack methods found`,
        );
      }

      return this.deriveOpStackConfig(address);
    }

    return this.deriveCcipConfig(address);
  }

  async deriveCcipConfig(
    address: Address,
  ): Promise<WithAddress<CCIPHookConfig>> {
    const ccipHook = CCIPHook__factory.connect(address, this.provider);
    const destinationDomain = await ccipHook.destinationDomain();
    const destinationChain = this.multiProvider.getChainName(destinationDomain);

    const config: WithAddress<CCIPHookConfig> = {
      address,
      type: HookType.CCIP,
      destinationChain,
    };

    this._cache.set(address, config);

    return config;
  }

  async deriveRateLimitedHookConfig(
    address: Address,
  ): Promise<WithAddress<RateLimitedHookConfig>> {
    const hook = RateLimitedHook__factory.connect(address, this.provider);

    const [hookType, maxCapacity, owner] = await Promise.all([
      hook.hookType(),
      hook.maxCapacity(),
      hook.owner(),
    ]);

    this.assertHookType(hookType, OnchainHookType.RATE_LIMITED);

    const config: WithAddress<RateLimitedHookConfig> = {
      address,
      type: HookType.RATE_LIMITED,
      maxCapacity: maxCapacity.toString(),
      owner,
    };

    this._cache.set(address, config);

    return config;
  }

  async deriveMerkleTreeConfig(
    address: Address,
  ): Promise<WithAddress<MerkleTreeHookConfig>> {
    const hook = MerkleTreeHook__factory.connect(address, this.provider);
    this.assertHookType(await hook.hookType(), OnchainHookType.MERKLE_TREE);

    const config: WithAddress<MerkleTreeHookConfig> = {
      address,
      type: HookType.MERKLE_TREE,
    };

    this._cache.set(address, config);

    return config;
  }

  async deriveAggregationConfig(
    address: Address,
  ): Promise<WithAddress<AggregationHookConfig>> {
    const hook = StaticAggregationHook__factory.connect(address, this.provider);

    // Parallelize hookType and hooks list fetching
    const [hookType, hooks] = await Promise.all([
      hook.hookType(),
      hook.hooks(ethers.constants.AddressZero),
    ]);

    this.assertHookType(hookType, OnchainHookType.AGGREGATION);

    const hookConfigs = await concurrentMap(
      this.concurrency,
      hooks,
      async (hookAddress) => {
        const derived = await this.deriveHookConfigFromAddress(hookAddress);
        return this.preserveUnredeployable(hookAddress, derived);
      },
    );

    const config: WithAddress<AggregationHookConfig> = {
      address,
      type: HookType.AGGREGATION,
      hooks: hookConfigs,
    };

    this._cache.set(address, config);

    return config;
  }

  possibleDomainIds(): number[] {
    const isTestnet = !!this.multiProvider.getChainMetadata(this.chain)
      .isTestnet;

    return this.messageContext
      ? [this.messageContext.parsed.destination]
      : // filter to only domains that are the same testnet/mainnet
        this.multiProvider
          .getKnownChainNames()
          .filter(
            (chainName) =>
              !!this.multiProvider.getChainMetadata(chainName).isTestnet ===
              isTestnet,
          )
          .map((chainName) => this.multiProvider.getDomainId(chainName));
  }

  async deriveIgpConfig(address: Address): Promise<WithAddress<IgpHookConfig>> {
    const hook = InterchainGasPaymaster__factory.connect(
      address,
      this.provider,
    );

    const getQuoteSignersResult = async (): Promise<{
      quoteSigners: string[];
      igpVersion?: IgpVersion;
    }> => {
      try {
        return { quoteSigners: await hook.quoteSigners() };
      } catch (error) {
        throwIfNotMissingSelectorRevert(error);
        this.logger.debug(
          'quoteSigners() not available on this IGP version, skipping',
        );
        return { quoteSigners: [], igpVersion: IgpVersion.Legacy };
      }
    };

    // Parallelize initial RPC calls
    const [hookType, owner, beneficiary, quoteSignersResult] =
      await Promise.all([
        hook.hookType(),
        hook.owner(),
        hook.beneficiary(),
        getQuoteSignersResult(),
      ]);

    this.assertHookType(hookType, OnchainHookType.INTERCHAIN_GAS_PAYMASTER);

    const overhead: IgpHookConfig['overhead'] = {};
    const oracleConfig: IgpHookConfig['oracleConfig'] = {};

    let oracleKey: string | undefined;

    const allKeys = await concurrentMap(
      this.concurrency,
      this.possibleDomainIds(),
      async (domainId) => {
        const { name: chainName, nativeToken } =
          this.multiProvider.getChainMetadata(domainId);
        try {
          const { tokenExchangeRate, gasPrice } =
            await hook.getExchangeRateAndGasPrice(domainId);
          const domainGasOverhead = await hook.destinationGasLimit(domainId, 0);

          overhead[chainName] = domainGasOverhead.toNumber();
          oracleConfig[chainName] = {
            tokenExchangeRate: tokenExchangeRate.toString(),
            gasPrice: gasPrice.toString(),
            tokenDecimals: nativeToken?.decimals,
          };

          const { gasOracle } = await hook.destinationGasConfigs(domainId);
          const oracle = StorageGasOracle__factory.connect(
            gasOracle,
            this.provider,
          );
          return oracle.owner();
        } catch (error) {
          if (!isUnsupportedIgpDomainError(error, domainId)) throw error;
          this.logger.debug(
            'Domain not configured on IGP Hook',
            domainId,
            chainName,
          );
          return null;
        }
      },
    );

    const resolvedOracleKeys = allKeys.filter(
      (key): key is string => key !== null,
    );

    if (resolvedOracleKeys.length > 0) {
      const allKeysMatch = resolvedOracleKeys.every((key) =>
        eqAddress(resolvedOracleKeys[0], key),
      );
      assert(allKeysMatch, 'Not all oracle keys match');
      oracleKey = resolvedOracleKeys[0];
    }

    const config: WithAddress<IgpHookConfig> = {
      owner,
      address,
      type: HookType.INTERCHAIN_GAS_PAYMASTER,
      beneficiary,
      oracleKey: oracleKey ?? owner,
      overhead,
      oracleConfig,
      ...(quoteSignersResult.igpVersion
        ? { igpVersion: quoteSignersResult.igpVersion }
        : {}),
      ...(quoteSignersResult.quoteSigners.length > 0
        ? { quoteSigners: [...quoteSignersResult.quoteSigners] }
        : {}),
    };

    this._cache.set(address, config);

    return config;
  }

  async deriveProtocolFeeConfig(
    address: Address,
  ): Promise<WithAddress<ProtocolFeeHookConfig>> {
    const hook = ProtocolFee__factory.connect(address, this.provider);

    // Parallelize all RPC calls
    const [hookType, owner, maxProtocolFee, protocolFee, beneficiary] =
      await Promise.all([
        hook.hookType(),
        hook.owner(),
        hook.MAX_PROTOCOL_FEE(),
        hook.protocolFee(),
        hook.beneficiary(),
      ]);

    this.assertHookType(hookType, OnchainHookType.PROTOCOL_FEE);

    const config: WithAddress<ProtocolFeeHookConfig> = {
      owner,
      address,
      type: HookType.PROTOCOL_FEE,
      maxProtocolFee: maxProtocolFee.toString(),
      protocolFee: protocolFee.toString(),
      beneficiary,
    };

    this._cache.set(address, config);

    return config;
  }

  async deriveOpStackConfig(
    address: Address,
  ): Promise<WithAddress<OpStackHookConfig>> {
    const hook = OPStackHook__factory.connect(address, this.provider);

    // Parallelize all RPC calls
    const [hookType, owner, messengerContract, destinationDomain] =
      await Promise.all([
        hook.hookType(),
        hook.owner(),
        hook.l1Messenger(),
        hook.destinationDomain(),
      ]);

    this.assertHookType(hookType, OnchainHookType.ID_AUTH_ISM);

    const destinationChainName =
      this.multiProvider.getChainName(destinationDomain);

    const config: WithAddress<OpStackHookConfig> = {
      owner,
      address,
      type: HookType.OP_STACK,
      nativeBridge: messengerContract,
      destinationChain: destinationChainName,
    };

    this._cache.set(address, config);

    return config;
  }

  async deriveArbL2ToL1Config(
    address: Address,
  ): Promise<WithAddress<ArbL2ToL1HookConfig>> {
    const hook = ArbL2ToL1Hook__factory.connect(address, this.provider);

    // Parallelize initial RPC calls
    const [arbSys, destinationDomain, childHookAddress] = await Promise.all([
      hook.arbSys(),
      hook.destinationDomain(),
      hook.childHook(),
    ]);

    const destinationChainName =
      this.multiProvider.getChainName(destinationDomain);

    const derivedChild =
      await this.deriveHookConfigFromAddress(childHookAddress);
    const childHookConfig = this.preserveUnredeployable(
      childHookAddress,
      derivedChild,
    );
    const config: WithAddress<ArbL2ToL1HookConfig> = {
      address,
      type: HookType.ARB_L2_TO_L1,
      destinationChain: destinationChainName,
      arbSys,
      childHook: childHookConfig,
    };

    this._cache.set(address, config);

    return config;
  }

  async deriveDomainRoutingConfig(
    address: Address,
  ): Promise<WithAddress<DomainRoutingHookConfig>> {
    const hook = DomainRoutingHook__factory.connect(address, this.provider);

    // Parallelize hookType, owner, and domain hooks fetching
    const [hookType, owner, domainHooks] = await Promise.all([
      hook.hookType(),
      hook.owner(),
      this.fetchDomainHooks(hook),
    ]);

    this.assertHookType(hookType, OnchainHookType.ROUTING);

    const config: WithAddress<DomainRoutingHookConfig> = {
      owner,
      address,
      type: HookType.ROUTING,
      domains: domainHooks,
    };

    this._cache.set(address, config);

    return config;
  }

  async deriveFallbackRoutingConfig(
    address: Address,
  ): Promise<WithAddress<FallbackRoutingHookConfig>> {
    const hook = FallbackDomainRoutingHook__factory.connect(
      address,
      this.provider,
    );

    // Parallelize hookType, owner, fallback hook address, and domain hooks fetching
    const [hookType, owner, fallbackHookAddress, domainHooks] =
      await Promise.all([
        hook.hookType(),
        hook.owner(),
        hook.fallbackHook(),
        this.fetchDomainHooks(hook),
      ]);

    this.assertHookType(hookType, OnchainHookType.FALLBACK_ROUTING);

    const derivedFallback =
      await this.deriveHookConfigFromAddress(fallbackHookAddress);
    const fallbackHookConfig = this.preserveUnredeployable(
      fallbackHookAddress,
      derivedFallback,
    );

    const config: WithAddress<FallbackRoutingHookConfig> = {
      owner,
      address,
      type: HookType.FALLBACK_ROUTING,
      domains: domainHooks,
      fallback: fallbackHookConfig,
    };

    this._cache.set(address, config);

    return config;
  }

  private async fetchDomainHooks(
    hook: DomainRoutingHook | FallbackDomainRoutingHook,
  ): Promise<RoutingHookConfig['domains']> {
    const domainHooks: RoutingHookConfig['domains'] = {};
    await concurrentMap(
      this.concurrency,
      this.possibleDomainIds(),
      async (domainId) => {
        const chainName = this.multiProvider.getChainName(domainId);
        const domainHook = await hook.hooks(domainId);
        if (!isZeroishAddress(domainHook)) {
          const derived = await this.deriveHookConfigFromAddress(domainHook);
          domainHooks[chainName] = this.preserveUnredeployable(
            domainHook,
            derived,
          );
        }
      },
    );

    return domainHooks;
  }

  async derivePausableConfig(
    address: Address,
  ): Promise<WithAddress<PausableHookConfig>> {
    const hook = PausableHook__factory.connect(address, this.provider);

    // Parallelize all RPC calls
    const [hookType, owner, paused] = await Promise.all([
      hook.hookType(),
      hook.owner(),
      hook.paused(),
    ]);

    this.assertHookType(hookType, OnchainHookType.PAUSABLE);

    const config: WithAddress<PausableHookConfig> = {
      owner,
      address,
      paused,
      type: HookType.PAUSABLE,
    };

    this._cache.set(address, config);

    return config;
  }

  private async deriveAmountRoutingHookConfig(
    address: Address,
  ): Promise<WithAddress<AmountRoutingHookConfig>> {
    const hook = AmountRoutingHook__factory.connect(address, this.provider);

    // Parallelize initial RPC calls including hookType
    const [hookType, threshold, lowerHookAddress, upperHookAddress] =
      await Promise.all([
        hook.hookType(),
        hook.threshold(),
        hook.lower(),
        hook.upper(),
      ]);

    this.assertHookType(hookType, OnchainHookType.AMOUNT_ROUTING);

    // Parallelize hook config derivation
    const [lowerDerived, upperDerived] = await Promise.all([
      this.deriveHookConfigFromAddress(lowerHookAddress),
      this.deriveHookConfigFromAddress(upperHookAddress),
    ]);
    const lowerHookConfig = this.preserveUnredeployable(
      lowerHookAddress,
      lowerDerived,
    );
    const upperHookConfig = this.preserveUnredeployable(
      upperHookAddress,
      upperDerived,
    );

    const config: WithAddress<AmountRoutingHookConfig> = {
      address,
      type: HookType.AMOUNT_ROUTING,
      threshold: threshold.toNumber(),
      lowerHook: lowerHookConfig,
      upperHook: upperHookConfig,
    };

    this._cache.set(address, config);

    return config;
  }

  assertHookType(
    hookType: OnchainHookType,
    expectedType: OnchainHookType,
  ): void {
    assert(
      hookType === expectedType,
      `expected hook type to be ${expectedType}, got ${hookType}`,
    );
  }
}
