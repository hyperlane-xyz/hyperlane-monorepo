import {
  Account,
  CairoCustomEnum,
  Contract,
  Provider as StarknetProvider,
  num,
} from 'starknet';

import { getCompiledContract } from '@hyperlane-xyz/starknet-core';
import { Address, WithAddress, rootLogger } from '@hyperlane-xyz/utils';

import { ChainMap } from '../types.js';

import {
  AggregationHookConfig,
  DomainRoutingHookConfig,
  FallbackRoutingHookConfig,
  HookConfig,
  HookType,
  MailboxDefaultHookConfig,
  MerkleTreeHookConfig,
  ProtocolFeeHookConfig,
} from './types.js';

export class StarknetHookReader {
  protected readonly logger = rootLogger.child({
    module: 'StarknetHookReader',
  });

  constructor(
    protected readonly starknetProviderOrSigner: Account | StarknetProvider,
  ) {}

  async deriveHookConfig(address: Address): Promise<HookConfig> {
    try {
      const { abi } = getCompiledContract('hook');
      const hook = new Contract(abi, address, this.starknetProviderOrSigner);

      const hookType: CairoCustomEnum = await hook.hook_type();
      const variant = hookType.activeVariant();
      switch (variant) {
        case 'AGGREGATION':
          return this.deriveAggregationHookConfig(address);
        case 'FALLBACK_ROUTING':
          return this.deriveFallbackRoutingHookConfig(address);
        case 'MAILBOX_DEFAULT_HOOK':
          return this.deriveMailboxDefaultHookConfig(address);
        case 'MERKLE_TREE':
          return this.deriveMerkleTreeConfig(address);
        case 'PROTOCOL_FEE':
          return this.deriveProtocolFeeConfig(address);
        case 'ROUTING':
          return this.deriveRoutingHookConfig(address);
        case 'UNUSED':
          return this.deriveMerkleTreeConfig(address);
        default:
          throw new Error(`Unsupported hook type: ${variant}`);
      }
    } catch (error) {
      this.logger.error(`Failed to derive Hook config for ${address}`, error);
      throw error;
    }
  }

  private async deriveMerkleTreeConfig(
    address: Address,
  ): Promise<WithAddress<MerkleTreeHookConfig>> {
    // TODO: assertHookType
    return {
      type: HookType.MERKLE_TREE,
      address,
    };
  }

  private async deriveProtocolFeeConfig(
    address: Address,
  ): Promise<WithAddress<ProtocolFeeHookConfig>> {
    const { abi } = getCompiledContract('protocol_fee');
    const hook = new Contract(abi, address, this.starknetProviderOrSigner);

    const [owner, protocolFee, beneficiary] = await Promise.all([
      hook.owner(),
      hook.get_protocol_fee(),
      hook.get_beneficiary(),
    ]);
    // no getter for max protocol fee
    // pub const MAX_PROTOCOL_FEE: u256 = 1000000000;

    return {
      type: HookType.PROTOCOL_FEE,
      address,
      owner: num.toHex64(owner.toString()),
      protocolFee: protocolFee.toString(),
      beneficiary: num.toHex64(beneficiary.toString()),
      maxProtocolFee: '1000000000',
    };
  }

  private async deriveRoutingHookConfig(
    address: Address,
  ): Promise<WithAddress<DomainRoutingHookConfig>> {
    const { abi } = getCompiledContract('domain_routing_hook');
    const hook = new Contract(abi, address, this.starknetProviderOrSigner);
    const [domains, owner] = await Promise.all([hook.domains(), hook.owner()]);
    const domainConfigs: Record<string, HookConfig> = {};
    for (const domain of domains) {
      try {
        const moduleAddress = await hook.hook(domain);
        const moduleConfig = await this.deriveHookConfig(
          num.toHex64(moduleAddress.toString()),
        );
        domainConfigs[domain.toString()] = moduleConfig;
      } catch (error) {
        this.logger.error(
          `Failed to derive config for domain ${domain}`,
          error,
        );
      }
    }

    return {
      type: HookType.ROUTING,
      address,
      domains: domainConfigs as ChainMap<HookConfig>,
      owner: num.toHex64(owner.toString()),
    };
  }

  private async deriveFallbackRoutingHookConfig(
    address: Address,
  ): Promise<WithAddress<FallbackRoutingHookConfig>> {
    const { abi } = getCompiledContract('fallback_domain_routing_hook');
    const hook = new Contract(abi, address, this.starknetProviderOrSigner);
    const [domains, owner, fallbackHookAddress] = await Promise.all([
      hook.domains(),
      hook.owner(),
      hook.fallback_hook(),
    ]);

    const domainConfigs: Record<string, HookConfig> = {};
    for (const domain of domains) {
      try {
        const moduleAddress = await hook.hook(domain);
        const moduleConfig = await this.deriveHookConfig(
          num.toHex64(moduleAddress.toString()),
        );
        domainConfigs[domain.toString()] = moduleConfig;
      } catch (error) {
        this.logger.error(
          `Failed to derive config for domain ${domain}`,
          error,
        );
      }
    }

    const fallbackHook = await this.deriveHookConfig(
      num.toHex64(fallbackHookAddress.toString()),
    );

    return {
      type: HookType.FALLBACK_ROUTING,
      address,
      domains: domainConfigs as ChainMap<HookConfig>,
      owner: num.toHex64(owner.toString()),
      fallback: fallbackHook,
    };
  }

  private async deriveAggregationHookConfig(
    address: Address,
  ): Promise<WithAddress<AggregationHookConfig>> {
    const { abi } = getCompiledContract('static_aggregation_hook');
    const hook = new Contract(abi, address, this.starknetProviderOrSigner);
    const hooks = await hook.get_hooks();
    const hookConfigs = await Promise.all(
      hooks.map(async (hookAddress: any) => {
        return await this.deriveHookConfig(num.toHex64(hookAddress.toString()));
      }),
    );

    return {
      type: HookType.AGGREGATION,
      address,
      hooks: hookConfigs.filter(Boolean),
    };
  }

  private async deriveMailboxDefaultHookConfig(
    address: Address,
  ): Promise<WithAddress<MailboxDefaultHookConfig>> {
    // TODO: assertHookType
    return {
      type: HookType.MAILBOX_DEFAULT,
      address,
    };
  }
}
