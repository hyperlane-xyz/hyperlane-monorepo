import { AltVM } from '@hyperlane-xyz/provider-sdk';
import { Address, Domain, WithAddress, rootLogger } from '@hyperlane-xyz/utils';

import {
  DerivedIsmConfig,
  DomainRoutingIsmConfig,
  IsmConfig,
  MultisigIsmConfig,
} from '@hyperlane-xyz/provider-sdk/ism';
import { Address, WithAddress, rootLogger } from '@hyperlane-xyz/utils';

/**
 * Function adapter to lookup chain name by domain ID, returns null if not found
 */
export type ChainNameLookup = (domainId: Domain) => string | null;

export class AltVMIsmReader {
  protected readonly logger = rootLogger.child({
    module: 'AltVMIsmReader',
  });

  constructor(
    protected readonly getChainName: ChainNameLookup,
    protected readonly provider: AltVM.IProvider,
  ) {}

  async deriveIsmConfigFromAddress(
    address: Address,
  ): Promise<DerivedIsmConfig> {
    try {
      const ism_type = await this.provider.getIsmType({ ismAddress: address });

      this.logger.debug(
        `Deriving ISM config with type ${ism_type} for address: ${address}`,
      );

      switch (ism_type) {
        case AltVM.IsmType.MERKLE_ROOT_MULTISIG:
          return this.deriveMerkleRootMultisigConfig(address);
        case AltVM.IsmType.MESSAGE_ID_MULTISIG:
          return this.deriveMessageIdMultisigConfig(address);
        case AltVM.IsmType.ROUTING:
          return this.deriveRoutingConfig(address);
        case AltVM.IsmType.TEST_ISM:
          return this.deriveTestConfig(address);
        default:
          throw new Error(`Unknown ISM ModuleType: ${ism_type}`);
      }
    } catch (error) {
      this.logger.error(`Failed to derive ISM config for ${address}`, error);
      throw error;
    }
  }

  async deriveIsmConfig(config: IsmConfig | string): Promise<DerivedIsmConfig> {
    if (typeof config === 'string')
      return this.deriveIsmConfigFromAddress(config);

    // Extend the inner isms
    switch (config.type) {
      case 'domainRoutingIsm':
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
      ismAddress: address,
    });

    return {
      type: 'merkleRootMultisigIsm',
      address,
      validators: ism.validators,
      threshold: ism.threshold,
    };
  }

  private async deriveMessageIdMultisigConfig(
    address: Address,
  ): Promise<WithAddress<MultisigIsmConfig>> {
    const ism = await this.provider.getMessageIdMultisigIsm({
      ismAddress: address,
    });

    return {
      type: 'messageIdMultisigIsm',
      address,
      validators: ism.validators,
      threshold: ism.threshold,
    };
  }

  private async deriveRoutingConfig(
    address: Address,
  ): Promise<WithAddress<DomainRoutingIsmConfig>> {
    const ism = await this.provider.getRoutingIsm({
      ismAddress: address,
    });

    const domains: DomainRoutingIsmConfig['domains'] = {};

    for (const route of ism.routes) {
      this.logger.debug(
        `Deriving ism config for route with domain id ${route.domainId}`,
      );

      const chainName = this.getChainName(route.domainId);
      if (!chainName) {
        this.logger.warn(
          `Unknown domain ID ${route.domainId}, skipping domain configuration`,
        );
        continue;
      }

      domains[chainName] = await this.deriveIsmConfig(route.ismAddress);
    }

    return {
      type: 'domainRoutingIsm',
      address,
      owner: ism.owner,
      domains,
    };
  }

  private async deriveTestConfig(address: Address): Promise<DerivedIsmConfig> {
    return {
      type: 'testIsm',
      address,
    };
  }
}
