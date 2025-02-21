import { Account, CairoCustomEnum, Contract, num } from 'starknet';

import { getCompiledContract } from '@hyperlane-xyz/starknet-core';
import { Address, rootLogger } from '@hyperlane-xyz/utils';

import { HookType } from './types.js';

export class StarknetHookReader {
  protected readonly logger = rootLogger.child({
    module: 'StarknetHookReader',
  });

  constructor(protected readonly signer: Account) {}

  async deriveHookConfig(address: Address): Promise<any> {
    try {
      const { abi } = getCompiledContract('hook');
      const hook = new Contract(abi, address, this.signer);

      const hookType: CairoCustomEnum = await hook.hook_type();
      switch (hookType.activeVariant()) {
        case 'UNUSED':
          return this.deriveUnusedConfig(address);
        case 'MERKLE_TREE':
          return this.deriveMerkleTreeConfig(address);
        case 'PROTOCOL_FEE':
          return this.deriveProtocolFeeConfig(address);
        default:
          throw Error;
      }
    } catch (error) {
      this.logger.error(`Failed to derive Hook config for ${address}`, error);
      throw error;
    }
  }

  private async deriveMerkleTreeConfig(address: Address) {
    return {
      type: HookType.MERKLE_TREE,
      address,
    };
  }

  private async deriveProtocolFeeConfig(address: Address) {
    const { abi } = getCompiledContract('protocol_fee');
    const hook = new Contract(abi, address, this.signer);

    const [owner, protocolFee, beneficiary] = await Promise.all([
      hook.owner(),
      hook.get_protocol_fee(),
      hook.get_beneficiary(),
    ]);
    return {
      type: HookType.PROTOCOL_FEE,
      address,
      owner: num.toHex64(owner.toString()),
      protocolFee: protocolFee.toString(),
      beneficiary: num.toHex64(beneficiary.toString()),
    };
  }

  private async deriveUnusedConfig(address: Address) {
    return {
      type: HookType.MERKLE_TREE,
      address,
    };
  }
}
