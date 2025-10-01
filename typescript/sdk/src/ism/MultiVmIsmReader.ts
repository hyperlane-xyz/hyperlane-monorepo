import {
  Address,
  MultiVM,
  WithAddress,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { ChainMetadataManager } from '../metadata/ChainMetadataManager.js';

import {
  DerivedIsmConfig,
  DomainRoutingIsmConfig,
  IsmConfig,
  IsmType,
  MultisigIsmConfig,
} from './types.js';

export class MultiVmIsmReader {
  protected readonly logger = rootLogger.child({
    module: 'MultiVmIsmReader',
  });

  constructor(
    protected readonly metadataManager: ChainMetadataManager,
    protected readonly provider: MultiVM.IMultiVMProvider,
  ) {}

  async deriveIsmConfigFromAddress(
    address: Address,
  ): Promise<DerivedIsmConfig> {
    try {
      const ism_type = await this.provider.getIsmType({ ism_id: address });

      switch (ism_type) {
        case MultiVM.IsmType.MERKLE_ROOT_MULTISIG_ISM:
          return this.deriveMerkleRootMultisigConfig(address);
        case MultiVM.IsmType.MESSAGE_ID_MULTISIG_ISM:
          return this.deriveMessageIdMultisigConfig(address);
        case MultiVM.IsmType.ROUTING_ISM:
          return this.deriveRoutingConfig(address);
        case MultiVM.IsmType.NOOP_ISM:
          return this.deriveTestConfig(address);
        default:
          throw new Error(`Unknown ISM ModuleType: ${ism_type}`);
      }
    } catch (error) {
      this.logger.error(`Failed to derive ISM config for ${address}`, error);
      throw error;
    }
  }

  async deriveIsmConfig(config: IsmConfig): Promise<DerivedIsmConfig> {
    if (typeof config === 'string')
      return this.deriveIsmConfigFromAddress(config);

    // Extend the inner isms
    switch (config.type) {
      case IsmType.ROUTING:
        for (const [chain, ism] of Object.entries(config.domains)) {
          config.domains[chain] = await this.deriveIsmConfig(ism);
        }
        break;
    }

    return config as DerivedIsmConfig;
  }

  private async deriveMerkleRootMultisigConfig(
    address: Address,
  ): Promise<WithAddress<MultisigIsmConfig>> {
    const ism = await this.provider.getMerkleRootMultisigIsm({
      ism_id: address,
    });

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
    const ism = await this.provider.getMessageIdMultisigIsm({
      ism_id: address,
    });

    return {
      type: IsmType.MESSAGE_ID_MULTISIG,
      address,
      validators: ism.validators,
      threshold: ism.threshold,
    };
  }

  private async deriveRoutingConfig(
    address: Address,
  ): Promise<WithAddress<DomainRoutingIsmConfig>> {
    const ism = await this.provider.getRoutingIsm({
      ism_id: address,
    });

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
