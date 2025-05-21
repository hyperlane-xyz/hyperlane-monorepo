import { num } from 'starknet';

import { Address, WithAddress, assert, rootLogger } from '@hyperlane-xyz/utils';

import { DEFAULT_CONTRACT_READ_CONCURRENCY } from '../consts/concurrency.js';
import { MultiProtocolProvider } from '../providers/MultiProtocolProvider.js';
import { StarknetJsProvider } from '../providers/ProviderType.js';
import { ChainNameOrId } from '../types.js';
import {
  StarknetContractName,
  getStarknetContract,
} from '../utils/starknet.js';

import {
  DerivedHookConfig,
  HookConfig,
  HookType,
  MerkleTreeHookConfig,
  ProtocolFeeHookConfig,
} from './types.js';

export class StarknetHookReader {
  protected readonly logger = rootLogger.child({
    module: 'StarknetHookReader',
  });
  protected readonly provider: StarknetJsProvider['provider'];

  constructor(
    protected readonly multiProvider: MultiProtocolProvider,
    protected readonly chain: ChainNameOrId,
    protected readonly concurrency: number = DEFAULT_CONTRACT_READ_CONCURRENCY,
  ) {
    this.provider = multiProvider.getStarknetProvider(chain);
  }

  async deriveHookConfig(
    addressOrConfig: HookConfig,
  ): Promise<DerivedHookConfig> {
    if (typeof addressOrConfig === 'string') {
      return this.deriveHookConfigFromAddress(addressOrConfig);
    }
    const address = (addressOrConfig as WithAddress<any>).address;
    assert(address, 'Address must be present in hook config object');
    return addressOrConfig as DerivedHookConfig;
  }

  async deriveHookConfigFromAddress(
    address: Address,
  ): Promise<DerivedHookConfig> {
    this.logger.debug('Deriving StarkNet HookConfig:', { address });

    try {
      // Attempt to derive as ProtocolFeeHook
      const protocolFeeConfig = await this.tryDeriveProtocolFeeConfig(address);
      if (protocolFeeConfig) {
        return protocolFeeConfig;
      }
    } catch (e) {
      this.logger.debug(
        `Not a ProtocolFeeHook or failed to derive: ${address}`,
        e,
      );
    }

    try {
      const merkleTreeConfig = await this.tryDeriveMerkleTreeConfig(address);
      if (merkleTreeConfig) {
        return merkleTreeConfig;
      }
    } catch (e) {
      this.logger.debug(
        `Not a MerkleTreeHook or failed to derive: ${address}`,
        e,
      );
    }

    this.logger.warn(
      `Failed to derive hook config for ${address} on ${this.chain}. It might be an unsupported hook type or an invalid address.`,
    );

    return address as HookConfig as DerivedHookConfig;
  }

  private async tryDeriveProtocolFeeConfig(
    address: Address,
  ): Promise<WithAddress<ProtocolFeeHookConfig> | null> {
    try {
      const contract = getStarknetContract(
        StarknetContractName.PROTOCOL_FEE, // Assuming a contract name enum exists
        address,
        this.provider,
      );

      const [owner, beneficiary, max_protocol_fee, protocol_fee_amount] =
        await Promise.all([
          contract.owner().then((r: any) => num.toHex(r)),
          contract.get_beneficiary().then((r: any) => num.toHex(r)),
          contract.get_max_protocol_fee().then((r: any) => r.toString()),
          contract.get_protocol_fee().then((r: any) => r.toString()),
        ]);

      return {
        address,
        type: HookType.PROTOCOL_FEE,
        owner,
        beneficiary,
        maxProtocolFee: max_protocol_fee,
        protocolFee: protocol_fee_amount,
      };
    } catch (e) {
      return null;
    }
  }

  private async tryDeriveMerkleTreeConfig(
    address: Address,
  ): Promise<WithAddress<MerkleTreeHookConfig> | null> {
    try {
      // const contract = getStarknetContract(
      //   StarknetContractName.MERKLE_TREE_HOOK,
      //   address,
      //   this.provider,
      // );

      return {
        address,
        type: HookType.MERKLE_TREE,
      };
    } catch (e) {
      return null;
    }
  }

  async deriveProtocolFeeConfig(
    address: Address,
  ): Promise<WithAddress<ProtocolFeeHookConfig>> {
    const config = await this.tryDeriveProtocolFeeConfig(address);
    if (!config)
      throw new Error(
        `Address ${address} is not a valid ProtocolFeeHook or failed to derive.`,
      );
    return config;
  }

  async deriveMerkleTreeConfig(
    address: Address,
  ): Promise<WithAddress<MerkleTreeHookConfig>> {
    const config = await this.tryDeriveMerkleTreeConfig(address);
    if (!config)
      throw new Error(
        `Address ${address} is not a valid MerkleTreeHook or failed to derive.`,
      );
    return config;
  }
}
