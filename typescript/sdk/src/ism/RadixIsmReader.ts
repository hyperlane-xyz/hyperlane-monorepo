import { RadixSDK } from '@hyperlane-xyz/radix-sdk';
import { Address, WithAddress, assert, rootLogger } from '@hyperlane-xyz/utils';

import { ChainMetadataManager } from '../metadata/ChainMetadataManager.js';

import { DerivedIsmConfig, IsmType, MultisigIsmConfig } from './types.js';

export class RadixIsmReader {
  protected readonly logger = rootLogger.child({
    module: 'RadixIsmReader',
  });

  constructor(
    protected readonly metadataManager: ChainMetadataManager,
    protected readonly sdk: RadixSDK,
  ) {}

  async deriveIsmConfig(address: Address): Promise<DerivedIsmConfig> {
    try {
      const ism = await this.sdk.queryIsm(address);

      assert(ism, `ISM with id ${address} not found`);

      switch (ism.type) {
        case 'MerkleRootMultisigIsm':
          return this.deriveMerkleRootMultisigConfig(address);
        case 'MessageIdMultisigIsm':
          return this.deriveMessageIdMultisigConfig(address);
        case 'NoopIsm':
          return this.deriveTestConfig(address);
        default:
          throw new Error(`Unknown ISM ModuleType: ${ism.type}`);
      }
    } catch (error) {
      this.logger.error(`Failed to derive ISM config for ${address}`, error);
      throw error;
    }
  }

  private async deriveMerkleRootMultisigConfig(
    address: Address,
  ): Promise<WithAddress<MultisigIsmConfig>> {
    const ism = await this.sdk.queryIsm(address);

    return {
      type: IsmType.MERKLE_ROOT_MULTISIG,
      address,
      validators: ism.validators,
      threshold: ism.threshold,
    };
  }

  private async deriveMessageIdMultisigConfig(
    address: Address,
  ): Promise<WithAddress<MultisigIsmConfig>> {
    const ism = await this.sdk.queryIsm(address);

    return {
      type: IsmType.MESSAGE_ID_MULTISIG,
      address,
      validators: ism.validators,
      threshold: ism.threshold,
    };
  }

  private async deriveTestConfig(address: Address): Promise<DerivedIsmConfig> {
    return {
      type: IsmType.TEST_ISM,
      address,
    };
  }
}
