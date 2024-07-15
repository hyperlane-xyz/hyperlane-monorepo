import { ethers, providers } from 'ethers';

import {
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
import { MultiProvider } from '../providers/MultiProvider.js';
import { ChainNameOrId } from '../types.js';

import {
  AggregationHookConfig,
  DomainRoutingHookConfig,
  FallbackRoutingHookConfig,
  HookConfig,
  HookType,
  IgpHookConfig,
  MerkleTreeHookConfig,
  OnchainHookType,
  OpStackHookConfig,
  PausableHookConfig,
  ProtocolFeeHookConfig,
  RoutingHookConfig,
} from './types.js';

export type DerivedHookConfig = WithAddress<Exclude<HookConfig, Address>>;

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
  deriveDomainRoutingConfig(
    address: Address,
  ): Promise<WithAddress<DomainRoutingHookConfig>>;
  deriveFallbackRoutingConfig(
    address: Address,
  ): Promise<WithAddress<FallbackRoutingHookConfig>>;
  derivePausableConfig(
    address: Address,
  ): Promise<WithAddress<PausableHookConfig>>;
  assertHookType(
    hookType: OnchainHookType,
    expectedType: OnchainHookType,
  ): void;
}

export class EvmHookReader implements HookReader {
  protected readonly provider: providers.Provider;
  protected readonly logger = rootLogger.child({ module: 'EvmHookReader' });

  constructor(
    protected readonly multiProvider: MultiProvider,
    protected readonly chain: ChainNameOrId,
    protected readonly concurrency: number = multiProvider.tryGetRpcConcurrency(
      chain,
    ) ?? DEFAULT_CONTRACT_READ_CONCURRENCY,
  ) {
    this.provider = multiProvider.getProvider(chain);
  }

  async deriveHookConfig(address: Address): Promise<DerivedHookConfig> {
    let onchainHookType = undefined;
    let derivedHookConfig: DerivedHookConfig;
    try {
      const hook = IPostDispatchHook__factory.connect(address, this.provider);
      this.logger.debug('Deriving HookConfig', { address });

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
        // ID_AUTH_ISM could be OPStackHook, ERC5164Hook or LayerZeroV2Hook
        // For now assume it's OP_STACK
        case OnchainHookType.ID_AUTH_ISM:
          derivedHookConfig = await this.deriveOpStackConfig(address);
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
    }

    this.setSmartProviderLogLevel(getLogLevel()); // returns to original level defined by rootLogger

    return derivedHookConfig;
  }

  async deriveMerkleTreeConfig(
    address: Address,
  ): Promise<WithAddress<MerkleTreeHookConfig>> {
    const hook = MerkleTreeHook__factory.connect(address, this.provider);
    this.assertHookType(await hook.hookType(), OnchainHookType.MERKLE_TREE);

    return {
      address,
      type: HookType.MERKLE_TREE,
    };
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

    return {
      address,
      type: HookType.AGGREGATION,
      hooks: hookConfigs,
    };
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

    const domainIds = this.multiProvider.getKnownDomainIds();

    const allKeys = await concurrentMap(
      this.concurrency,
      domainIds,
      async (domainId) => {
        const chainName = this.multiProvider.getChainName(domainId);
        try {
          const { tokenExchangeRate, gasPrice } =
            await hook.getExchangeRateAndGasPrice(domainId);
          const domainGasOverhead = await hook.destinationGasLimit(domainId, 0);

          overhead[chainName] = domainGasOverhead.toNumber();
          oracleConfig[chainName] = {
            tokenExchangeRate: tokenExchangeRate.toString(),
            gasPrice: gasPrice.toString(),
          };

          const { gasOracle } = await hook.destinationGasConfigs(domainId);
          const oracle = StorageGasOracle__factory.connect(
            gasOracle,
            this.provider,
          );
          return oracle.owner();
        } catch (error) {
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

    return {
      owner,
      address,
      type: HookType.INTERCHAIN_GAS_PAYMASTER,
      beneficiary,
      oracleKey: oracleKey ?? owner,
      overhead,
      oracleConfig,
    };
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

    return {
      owner,
      address,
      type: HookType.PROTOCOL_FEE,
      maxProtocolFee: maxProtocolFee.toString(),
      protocolFee: protocolFee.toString(),
      beneficiary,
    };
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

    return {
      owner,
      address,
      type: HookType.OP_STACK,
      nativeBridge: messengerContract,
      destinationChain: destinationChainName,
    };
  }

  async deriveDomainRoutingConfig(
    address: Address,
  ): Promise<WithAddress<DomainRoutingHookConfig>> {
    const hook = DomainRoutingHook__factory.connect(address, this.provider);
    this.assertHookType(await hook.hookType(), OnchainHookType.ROUTING);

    const owner = await hook.owner();
    const domainHooks = await this.fetchDomainHooks(hook);

    return {
      owner,
      address,
      type: HookType.ROUTING,
      domains: domainHooks,
    };
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

    return {
      owner,
      address,
      type: HookType.FALLBACK_ROUTING,
      domains: domainHooks,
      fallback: fallbackHookConfig,
    };
  }

  private async fetchDomainHooks(
    hook: DomainRoutingHook | FallbackDomainRoutingHook,
  ): Promise<RoutingHookConfig['domains']> {
    const domainIds = this.multiProvider.getKnownDomainIds();

    const domainHooks: RoutingHookConfig['domains'] = {};
    await concurrentMap(this.concurrency, domainIds, async (domainId) => {
      const chainName = this.multiProvider.getChainName(domainId);
      try {
        const domainHook = await hook.hooks(domainId);
        if (domainHook !== ethers.constants.AddressZero) {
          domainHooks[chainName] = await this.deriveHookConfig(domainHook);
        }
      } catch (error) {
        this.logger.debug(
          `Domain not configured on ${hook.constructor.name}`,
          domainId,
          chainName,
        );
      }
    });

    return domainHooks;
  }

  async derivePausableConfig(
    address: Address,
  ): Promise<WithAddress<PausableHookConfig>> {
    const hook = PausableHook__factory.connect(address, this.provider);
    this.assertHookType(await hook.hookType(), OnchainHookType.PAUSABLE);

    const owner = await hook.owner();
    const paused = await hook.paused();
    return {
      owner,
      address,
      paused,
      type: HookType.PAUSABLE,
    };
  }

  /**
   * Conditionally sets the log level for a smart provider.
   *
   * @param level - The log level to set, e.g. 'debug', 'info', 'warn', 'error'.
   */
  protected setSmartProviderLogLevel(level: string): void {
    if ('setLogLevel' in this.provider) {
      //@ts-ignore
      this.provider.setLogLevel(level);
    }
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
