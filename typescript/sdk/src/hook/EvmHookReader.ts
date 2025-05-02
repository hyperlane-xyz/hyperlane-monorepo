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
  rootLogger,
} from '@hyperlane-xyz/utils';

import { DEFAULT_CONTRACT_READ_CONCURRENCY } from '../consts/concurrency.js';
import { DispatchedMessage } from '../core/types.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { ChainNameOrId } from '../types.js';
import { HyperlaneReader } from '../utils/HyperlaneReader.js';

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
  IgpHookConfig,
  MailboxDefaultHookConfig,
  MerkleTreeHookConfig,
  OnchainHookType,
  OpStackHookConfig,
  PausableHookConfig,
  ProtocolFeeHookConfig,
  RoutingHookConfig,
} from './types.js';

export interface HookReader {
  deriveHookConfig(address: Address): Promise<WithAddress<HookConfig>>;
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

  async deriveHookConfig(address: Address): Promise<DerivedHookConfig> {
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
        default:
          throw new Error(
            `Unsupported HookType: ${OnchainHookType[onchainHookType]}`,
          );
      }
    } catch (e: any) {
      let customMessage: string = `Failed to derive ${onchainHookType} hook (${address})`;
      if (
        !onchainHookType &&
        e.message.includes('Invalid response from provider')
      ) {
        customMessage = customMessage.concat(
          ` [The provided hook contract might be outdated and not support hookType()]`,
        );
        this.logger.info(`${customMessage}:\n\t${e}`);
      } else {
        this.logger.debug(`${customMessage}:\n\t${e}`);
      }
      throw new Error(`${customMessage}:\n\t${e}`);
    } finally {
      this.setSmartProviderLogLevel(getLogLevel()); // returns to original level defined by rootLogger
    }

    return derivedHookConfig;
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
    try {
      const ccipHook = CCIPHook__factory.connect(address, this.provider);
      // This method only exists on CCIPHook
      await ccipHook.ccipDestination();
      return this.deriveCcipConfig(address);
    } catch {
      // Not a CCIP hook, try OPStack
      try {
        const opStackHook = OPStackHook__factory.connect(
          address,
          this.provider,
        );
        // This method only exists on OPStackHook
        await opStackHook.l1Messenger();
        return this.deriveOpStackConfig(address);
      } catch {
        throw new Error(
          `Could not determine hook type - neither CCIP nor OPStack methods found`,
        );
      }
    }
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
    this.assertHookType(await hook.hookType(), OnchainHookType.AGGREGATION);

    const hooks = await hook.hooks(ethers.constants.AddressZero);
    const hookConfigs: DerivedHookConfig[] = await concurrentMap(
      this.concurrency,
      hooks,
      (hook) => this.deriveHookConfig(hook),
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
    this.assertHookType(
      await hook.hookType(),
      OnchainHookType.INTERCHAIN_GAS_PAYMASTER,
    );

    const owner = await hook.owner();
    const beneficiary = await hook.beneficiary();

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
        } catch {
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
    };

    this._cache.set(address, config);

    return config;
  }

  async deriveProtocolFeeConfig(
    address: Address,
  ): Promise<WithAddress<ProtocolFeeHookConfig>> {
    const hook = ProtocolFee__factory.connect(address, this.provider);
    this.assertHookType(await hook.hookType(), OnchainHookType.PROTOCOL_FEE);

    const owner = await hook.owner();
    const maxProtocolFee = await hook.MAX_PROTOCOL_FEE();
    const protocolFee = await hook.protocolFee();
    const beneficiary = await hook.beneficiary();

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
    const owner = await hook.owner();
    this.assertHookType(await hook.hookType(), OnchainHookType.ID_AUTH_ISM);

    const messengerContract = await hook.l1Messenger();
    const destinationDomain = await hook.destinationDomain();
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
    const arbSys = await hook.arbSys();

    const destinationDomain = await hook.destinationDomain();
    const destinationChainName =
      this.multiProvider.getChainName(destinationDomain);

    const childHookAddress = await hook.childHook();
    const childHookConfig = await this.deriveHookConfig(childHookAddress);
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

    this.assertHookType(await hook.hookType(), OnchainHookType.ROUTING);

    const owner = await hook.owner();
    const domainHooks = await this.fetchDomainHooks(hook);

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

    this.assertHookType(
      await hook.hookType(),
      OnchainHookType.FALLBACK_ROUTING,
    );

    const owner = await hook.owner();
    const domainHooks = await this.fetchDomainHooks(hook);

    const fallbackHook = await hook.fallbackHook();
    const fallbackHookConfig = await this.deriveHookConfig(fallbackHook);

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
        try {
          const domainHook = await hook.hooks(domainId);
          if (domainHook !== ethers.constants.AddressZero) {
            domainHooks[chainName] = await this.deriveHookConfig(domainHook);
          }
        } catch {
          this.logger.debug(
            `Domain not configured on ${hook.constructor.name}`,
            domainId,
            chainName,
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
    this.assertHookType(await hook.hookType(), OnchainHookType.PAUSABLE);

    const owner = await hook.owner();
    const paused = await hook.paused();
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
    this.assertHookType(await hook.hookType(), OnchainHookType.AMOUNT_ROUTING);

    const [threshold, lowerHook, upperHook] = await Promise.all([
      hook.threshold(),
      hook.lower(),
      hook.upper(),
    ]);

    const config: WithAddress<AmountRoutingHookConfig> = {
      address,
      type: HookType.AMOUNT_ROUTING,
      threshold: threshold.toNumber(),
      lowerHook: await this.deriveHookConfig(lowerHook),
      upperHook: await this.deriveHookConfig(upperHook),
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
