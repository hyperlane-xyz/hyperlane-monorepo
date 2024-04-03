import { BigNumber, ethers, providers } from 'ethers';

import {
  DomainRoutingHook__factory,
  FallbackDomainRoutingHook__factory,
  IPostDispatchHook__factory,
  InterchainGasPaymaster__factory,
  OPStackHook__factory,
  PausableHook__factory,
  ProtocolFee__factory,
  StaticAggregationHook__factory,
  StorageGasOracle__factory,
} from '@hyperlane-xyz/core';
import { Address, ProtocolType } from '@hyperlane-xyz/utils';

import { Chains } from '../consts/chains.js';
import { MultiProvider } from '../providers/MultiProvider.js';

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
  mapOnchainHookToHookType,
} from './types.js';

interface HookReader<_ extends ProtocolType> {
  deriveHookConfig(address: Address): Promise<HookConfig>;
  deriveMerkleTreeConfig(address: Address): Promise<MerkleTreeHookConfig>;
  deriveAggregationConfig(address: Address): Promise<AggregationHookConfig>;
  deriveIgpConfig(address: Address): Promise<IgpHookConfig>;
  deriveProtocolFeeConfig(address: Address): Promise<ProtocolFeeHookConfig>;
  deriveOpStackConfig(address: Address): Promise<OpStackHookConfig>;
  deriveDomainRoutingConfig(address: Address): Promise<DomainRoutingHookConfig>;
  deriveFallbackRoutingConfig(
    address: Address,
  ): Promise<FallbackRoutingHookConfig>;
  derivePausableConfig(address: Address): Promise<PausableHookConfig>;
}

export class EvmHookReader implements HookReader<ProtocolType.Ethereum> {
  protected readonly provider: providers.Provider;

  constructor(protected readonly multiProvider: MultiProvider, chain: Chains) {
    this.provider = this.multiProvider.getProvider(chain);
  }

  public static stringifyConfig(config: HookConfig, space?: number): string {
    return JSON.stringify(
      config,
      (_, value) => {
        // Check if the value looks like a serialized BigNumber
        if (
          typeof value === 'object' &&
          value !== null &&
          value.type === 'BigNumber' &&
          value.hex
        ) {
          return BigNumber.from(value.hex).toString();
        }
        // Handle bigint values
        return typeof value === 'bigint' ? value.toString() : value;
      },
      space,
    );
  }

  async deriveHookConfig(address: Address): Promise<HookConfig> {
    const hook = IPostDispatchHook__factory.connect(address, this.provider);
    const onchainHookType: OnchainHookType = await hook.hookType();
    const hookType = mapOnchainHookToHookType(onchainHookType);

    switch (hookType) {
      case HookType.MERKLE_TREE:
        return this.deriveMerkleTreeConfig(address);
      case HookType.AGGREGATION:
        return this.deriveAggregationConfig(address);
      case HookType.INTERCHAIN_GAS_PAYMASTER:
        return this.deriveIgpConfig(address);
      case HookType.PROTOCOL_FEE:
        return this.deriveProtocolFeeConfig(address);
      case HookType.OP_STACK:
        return this.deriveOpStackConfig(address);
      case HookType.ROUTING:
        return this.deriveDomainRoutingConfig(address);
      case HookType.FALLBACK_ROUTING:
        return this.deriveFallbackRoutingConfig(address);
      case HookType.PAUSABLE:
        return this.derivePausableConfig(address);
      default:
        throw new Error(`Unsupported HookType: ${hookType}`);
    }
  }

  async deriveMerkleTreeConfig(_: Address): Promise<MerkleTreeHookConfig> {
    return {
      type: HookType.MERKLE_TREE,
    };
  }

  async deriveAggregationConfig(
    address: Address,
  ): Promise<AggregationHookConfig> {
    const hook = StaticAggregationHook__factory.connect(address, this.provider);
    const hooks = await hook.hooks(ethers.constants.AddressZero);
    const hookConfigs = await Promise.all(
      hooks.map(this.deriveHookConfig.bind(this)),
    );

    return {
      type: HookType.AGGREGATION,
      hooks: hookConfigs,
    };
  }

  async deriveIgpConfig(address: Address): Promise<IgpHookConfig> {
    const hook = InterchainGasPaymaster__factory.connect(
      address,
      this.provider,
    );

    const owner = await hook.owner();
    const beneficiary = await hook.beneficiary();

    const overhead: IgpHookConfig['overhead'] = {};
    const oracleConfig: IgpHookConfig['oracleConfig'] = {};

    let oracleKey: string | undefined;

    for (const domainId of this.multiProvider.getKnownDomainIds()) {
      const chainName = this.multiProvider.getChainName(domainId);

      // if getExchangeRateAndGasPrice throws or destinationGasLimit returns 0
      // then no gasOracle has been configured for the given domainId
      try {
        // this will throw if no gasOracle configured
        const { tokenExchangeRate, gasPrice } =
          await hook.getExchangeRateAndGasPrice(domainId);
        // this will simply return 0 if not configured
        const domainGasOverhead = await hook.destinationGasLimit(domainId, 0);

        overhead[chainName] = domainGasOverhead.toNumber();
        oracleConfig[chainName] = { tokenExchangeRate, gasPrice };

        // we're going to assume that the owner of the first oracle we encounter
        // is the owner of all the oracles referenced in this IgpHook
        if (!oracleKey) {
          const { gasOracle } = await hook.destinationGasConfigs(domainId);
          const oracle = StorageGasOracle__factory.connect(
            gasOracle,
            this.provider,
          );
          oracleKey = await oracle.owner();
        }
      } catch (error) {
        // do nothing and continue iterating through known domain IDs
      }
    }

    return {
      owner,
      type: HookType.INTERCHAIN_GAS_PAYMASTER,
      beneficiary,
      oracleKey: oracleKey ?? owner,
      overhead,
      oracleConfig,
    };
  }

  async deriveProtocolFeeConfig(
    address: Address,
  ): Promise<ProtocolFeeHookConfig> {
    const hook = ProtocolFee__factory.connect(address, this.provider);

    const owner = await hook.owner();
    const maxProtocolFee = await hook.MAX_PROTOCOL_FEE();
    const protocolFee = await hook.protocolFee();
    const beneficiary = await hook.beneficiary();

    return {
      owner,
      type: HookType.PROTOCOL_FEE,
      maxProtocolFee: maxProtocolFee.toString(),
      protocolFee: protocolFee.toString(),
      beneficiary,
    };
  }

  async deriveOpStackConfig(address: Address): Promise<OpStackHookConfig> {
    const hook = OPStackHook__factory.connect(address, this.provider);

    const messengerContract = await hook.l1Messenger();
    const destinationDomain = await hook.destinationDomain();
    const destinationChainName =
      this.multiProvider.getChainName(destinationDomain);

    return {
      type: HookType.OP_STACK,
      nativeBridge: messengerContract,
      destinationChain: destinationChainName,
    };
  }

  async deriveDomainRoutingConfig(
    address: Address,
  ): Promise<DomainRoutingHookConfig> {
    const hook = DomainRoutingHook__factory.connect(address, this.provider);
    const owner = await hook.owner();

    const domainHooks: DomainRoutingHookConfig['domains'] = {};

    for (const domainId of this.multiProvider.getKnownDomainIds()) {
      const chainName = this.multiProvider.getChainName(domainId);
      try {
        const domainHook = await hook.hooks(domainId);
        if (domainHook === ethers.constants.AddressZero) {
          continue;
        }
        domainHooks[chainName] = await this.deriveHookConfig(domainHook);
      } catch (error) {
        // if it throws, no entry for that domainId
        // do nothing and continue iterating through known domain IDs
      }
    }

    return {
      owner,
      type: HookType.ROUTING,
      domains: domainHooks,
    };
  }

  async deriveFallbackRoutingConfig(
    address: Address,
  ): Promise<FallbackRoutingHookConfig> {
    const hook = FallbackDomainRoutingHook__factory.connect(
      address,
      this.provider,
    );
    const owner = await hook.owner();

    const domainHooks: DomainRoutingHookConfig['domains'] = {};

    for (const domainId of this.multiProvider.getKnownDomainIds()) {
      const chainName = this.multiProvider.getChainName(domainId);
      try {
        const domainHook = await hook.hooks(domainId);
        if (domainHook === ethers.constants.AddressZero) {
          continue;
        }
        domainHooks[chainName] = await this.deriveHookConfig(domainHook);
      } catch (error) {
        // if it throws, no entry for that domainId
        // do nothing and continue iterating through known domain IDs
      }
    }

    const fallbackHook = await hook.fallbackHook();
    const fallbackHookConfig = await this.deriveHookConfig(fallbackHook);

    return {
      owner,
      type: HookType.FALLBACK_ROUTING,
      domains: domainHooks,
      fallback: fallbackHookConfig,
    };
  }

  async derivePausableConfig(address: Address): Promise<PausableHookConfig> {
    const hook = PausableHook__factory.connect(address, this.provider);
    const owner = await hook.owner();
    return {
      owner,
      type: HookType.PAUSABLE,
    };
  }
}
