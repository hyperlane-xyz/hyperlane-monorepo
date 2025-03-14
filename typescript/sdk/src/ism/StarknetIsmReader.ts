import { Account, CairoCustomEnum, Contract, num } from 'starknet';

import { getCompiledContract } from '@hyperlane-xyz/starknet-core';
import { Address, WithAddress, rootLogger } from '@hyperlane-xyz/utils';

import { DerivedIsmConfig } from './EvmIsmReader.js';
import { StarknetIsmContractName } from './starknet-utils.js';
import {
  AggregationIsmConfig,
  IsmType,
  MultisigIsmConfig,
  RoutingIsmConfig,
} from './types.js';

export class StarknetIsmReader {
  protected readonly logger = rootLogger.child({ module: 'StarknetIsmReader' });

  constructor(protected readonly signer: Account) {}

  private getContractAbi(ismType: keyof typeof StarknetIsmContractName) {
    return getCompiledContract(StarknetIsmContractName[ismType]).abi;
  }

  async deriveIsmConfig(address: Address): Promise<DerivedIsmConfig> {
    try {
      const ism = new Contract(
        this.getContractAbi(IsmType.MERKLE_ROOT_MULTISIG), // fn module_type same across all isms
        address,
        this.signer,
      );
      const moduleType: CairoCustomEnum = await ism.module_type();
      const variant = moduleType.activeVariant();
      switch (variant) {
        case 'UNUSED':
          throw new Error('Error deriving NULL ISM type');
        case 'MESSAGE_ID_MULTISIG':
          return this.deriveMessageIdMultisigConfig(address);
        case 'MERKLE_ROOT_MULTISIG':
          return this.deriveMerkleRootMultisigConfig(address);
        case 'ROUTING':
          return this.deriveRoutingConfig(address);
        case 'AGGREGATION':
          return this.deriveAggregationConfig(address);
        case 'CCIP_READ':
          throw new Error('CCIP_READ does not have a corresponding IsmType');
        default:
          throw new Error(`Unknown ISM ModuleType: ${moduleType}`);
      }
    } catch (error) {
      this.logger.error(`Failed to derive ISM config for ${address}`, error);
      throw error;
    }
  }

  private async deriveMessageIdMultisigConfig(
    address: Address,
  ): Promise<DerivedIsmConfig> {
    const ism = new Contract(
      this.getContractAbi(IsmType.MESSAGE_ID_MULTISIG),
      address,
      this.signer,
    );

    const [validators, threshold] = await Promise.all([
      ism.get_validators(),
      ism.get_threshold(),
    ]);

    return {
      type: IsmType.MESSAGE_ID_MULTISIG,
      address,
      validators: validators.map((v: any) => num.toHex64(v.toString())),
      threshold: threshold.toString(),
    };
  }

  private async deriveMerkleRootMultisigConfig(
    address: Address,
  ): Promise<WithAddress<MultisigIsmConfig>> {
    const ism = new Contract(
      this.getContractAbi(IsmType.MERKLE_ROOT_MULTISIG),
      address,
      this.signer,
    );

    const [validators, threshold] = await Promise.all([
      ism.get_validators(),
      ism.get_threshold(),
    ]);

    return {
      type: IsmType.MERKLE_ROOT_MULTISIG,
      address,
      validators: validators.map((v: any) => num.toHex64(v.toString())),
      threshold: threshold.toString(),
    };
  }

  private async deriveRoutingConfig(
    address: Address,
  ): Promise<WithAddress<RoutingIsmConfig>> {
    const ism = new Contract(
      this.getContractAbi(IsmType.ROUTING),
      address,
      this.signer,
    );

    const [domains, owner] = await Promise.all([ism.domains(), ism.owner()]);
    const domainConfigs: Record<string, any> = {};

    for (const domain of domains) {
      try {
        const module = await ism.module(domain);
        const moduleConfig = await this.deriveIsmConfig(
          num.toHex64(module.toString()),
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
      type: IsmType.ROUTING,
      address,
      domains: domainConfigs,
      owner: num.toHex64(owner.toString()),
    };
  }

  private async deriveAggregationConfig(
    address: Address,
  ): Promise<WithAddress<AggregationIsmConfig>> {
    const ism = new Contract(
      this.getContractAbi(IsmType.AGGREGATION),
      address,
      this.signer,
    );

    const [modules, threshold] = await Promise.all([
      ism.get_modules(),
      ism.get_threshold(),
    ]);

    const moduleConfigs = await Promise.all(
      modules.map(async (moduleAddress: any) => {
        return await this.deriveIsmConfig(
          num.toHex64(moduleAddress.toString()),
        );
      }),
    );

    return {
      type: IsmType.AGGREGATION,
      address,
      modules: moduleConfigs.filter(Boolean),
      threshold: threshold.toString(),
    };
  }
}
