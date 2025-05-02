import {
  HyperlaneModuleClient,
  IsmTypes,
  SigningHyperlaneModuleClient,
} from '@hyperlane-xyz/cosmos-sdk';
import { Address, WithAddress, rootLogger } from '@hyperlane-xyz/utils';

import { DerivedIsmConfig, IsmType, MultisigIsmConfig } from './types.js';

export class CosmosNativeIsmReader {
  protected readonly logger = rootLogger.child({
    module: 'CosmosNativeIsmReader',
  });

  constructor(
    protected readonly cosmosProviderOrSigner:
      | HyperlaneModuleClient
      | SigningHyperlaneModuleClient,
  ) {}

  async deriveIsmConfig(address: Address): Promise<DerivedIsmConfig> {
    try {
      const { ism } =
        await this.cosmosProviderOrSigner.query.interchainSecurity.Ism({
          id: address,
        });

      switch (ism?.type_url) {
        case IsmTypes.MerkleRootMultisigISM:
          return this.deriveMerkleRootMultisigConfig(address);
        case IsmTypes.MessageIdMultisigISM:
          return this.deriveMessageIdMultisigConfig(address);
        case IsmTypes.NoopISM:
          return this.deriveTestConfig(address);
        default:
          throw new Error(`Unknown ISM ModuleType: ${ism?.type_url}`);
      }
    } catch (error) {
      this.logger.error(`Failed to derive ISM config for ${address}`, error);
      throw error;
    }
  }

  private async deriveMerkleRootMultisigConfig(
    address: Address,
  ): Promise<WithAddress<MultisigIsmConfig>> {
    const { ism } =
      await this.cosmosProviderOrSigner.query.interchainSecurity.DecodedIsm({
        id: address,
      });

    // perform type narrowing
    if ('validators' in ism && 'threshold' in ism) {
      return {
        type: IsmType.MERKLE_ROOT_MULTISIG,
        address,
        validators: ism.validators,
        threshold: ism.threshold,
      };
    }

    throw new Error(
      `found no validators and threshold in MERKLE_ROOT_MULTISIG ISM: ${address}`,
    );
  }

  private async deriveMessageIdMultisigConfig(
    address: Address,
  ): Promise<DerivedIsmConfig> {
    const { ism } =
      await this.cosmosProviderOrSigner.query.interchainSecurity.DecodedIsm({
        id: address,
      });

    // perform type narrowing
    if ('validators' in ism && 'threshold' in ism) {
      return {
        type: IsmType.MESSAGE_ID_MULTISIG,
        address,
        validators: ism.validators,
        threshold: ism.threshold,
      };
    }

    throw new Error(
      `found no validators and threshold in MESSAGE_ID_MULTISIG ISM: ${address}`,
    );
  }

  private async deriveTestConfig(address: Address): Promise<DerivedIsmConfig> {
    return {
      type: IsmType.TEST_ISM,
      address,
    };
  }
}
