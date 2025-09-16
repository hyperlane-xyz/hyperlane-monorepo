import { RadixSDK, RadixSigningSDK } from '@hyperlane-xyz/radix-sdk';
import { Address, WithAddress, assert, rootLogger } from '@hyperlane-xyz/utils';

import { ChainMetadataManager } from '../metadata/ChainMetadataManager.js';

import {
  DerivedIsmConfig,
  DomainRoutingIsmConfig,
  IsmType,
  MultisigIsmConfig,
  RadixIsmTypes,
} from './types.js';

export class RadixIsmReader {
  protected readonly logger = rootLogger.child({
    module: 'RadixIsmReader',
  });

  constructor(
    protected readonly metadataManager: ChainMetadataManager,
    protected readonly sdk: RadixSDK | RadixSigningSDK,
  ) {}

  async deriveIsmConfig(address: Address): Promise<DerivedIsmConfig> {
    try {
      const ismType = await this.sdk.query.core.getIsmType({ ism: address });

      assert(ismType, `ISM with id ${address} not found`);

      switch (ismType) {
        case RadixIsmTypes.MERKLE_ROOT_MULTISIG:
          return this.deriveMerkleRootMultisigConfig(address);
        case RadixIsmTypes.MESSAGE_ID_MULTISIG:
          return this.deriveMessageIdMultisigConfig(address);
        case RadixIsmTypes.ROUTING_ISM:
          return this.deriveRoutingIsmConfig(address);
        case RadixIsmTypes.NOOP_ISM:
          return this.deriveTestConfig(address);
        default:
          throw new Error(`Unknown ISM ModuleType: ${ismType}`);
      }
    } catch (error) {
      this.logger.error(`Failed to derive ISM config for ${address}`, error);
      throw error;
    }
  }

  private async deriveMerkleRootMultisigConfig(
    address: Address,
  ): Promise<WithAddress<MultisigIsmConfig>> {
    const ism = await this.sdk.query.core.getMultisigIsm({ ism: address });

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
    const ism = await this.sdk.query.core.getMultisigIsm({ ism: address });

    return {
      type: IsmType.MESSAGE_ID_MULTISIG,
      address,
      validators: ism.validators,
      threshold: ism.threshold,
    };
  }

  private async deriveRoutingIsmConfig(
    address: Address,
  ): Promise<WithAddress<DomainRoutingIsmConfig>> {
    const ism = await this.sdk.query.core.getRoutingIsm({ ism: address });

    const domains: DomainRoutingIsmConfig['domains'] = {};

    for (const route of ism.routes) {
      const chainName = this.metadataManager.tryGetChainName(route.domain);
      if (!chainName) {
        this.logger.warn(
          `Unknown domain ID ${route.domain}, skipping domain configuration`,
        );
        continue;
      }

      domains[chainName] = await this.deriveIsmConfig(route.ism);
    }

    return {
      type: IsmType.ROUTING,
      address,
      owner: ism.owner,
      domains,
    };
  }

  private async deriveTestConfig(address: Address): Promise<DerivedIsmConfig> {
    return {
      type: IsmType.TEST_ISM,
      address,
    };
  }
}
