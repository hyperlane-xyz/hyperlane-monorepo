import { Account, CairoCustomEnum, Contract, num } from 'starknet';

import { getCompiledContract } from '@hyperlane-xyz/starknet-core';
import { Address, rootLogger } from '@hyperlane-xyz/utils';

import { StarknetIsmContractName } from './starknet-utils.js';
import { IsmType } from './types.js';

export class StarknetIsmReader {
  protected readonly logger = rootLogger.child({ module: 'StarknetIsmReader' });

  constructor(protected readonly signer: Account) {}

  private getContractAbi(ismType: keyof typeof StarknetIsmContractName) {
    return getCompiledContract(StarknetIsmContractName[ismType]).abi;
  }

  async deriveIsmConfig(address: Address): Promise<any> {
    try {
      const ism = new Contract(
        this.getContractAbi(IsmType.ROUTING),
        address,
        this.signer,
      );
      const moduleType: CairoCustomEnum = await ism.module_type();
      switch (moduleType.activeVariant()) {
        case 'NULL':
          return this.deriveNullConfig(address);
        case 'MESSAGE_ID_MULTISIG':
          return this.deriveMessageIdMultisigConfig(address);
        case 'MERKLE_ROOT_MULTISIG':
          return this.deriveMerkleRootMultisigConfig(address);
        case 'ROUTING':
          return this.deriveRoutingConfig(address);
        case 'FALLBACK_ROUTING':
          return this.deriveFallbackRoutingConfig(address);
        case 'AGGREGATION':
          return this.deriveAggregationConfig(address);
        default:
          return {
            type: IsmType.TEST_ISM,
            address,
          };
      }
    } catch (error) {
      this.logger.error(`Failed to derive ISM config for ${address}`, error);
      throw error;
    }
  }

  private async deriveNullConfig(address: Address) {
    try {
      const ism = new Contract(
        this.getContractAbi(IsmType.PAUSABLE),
        address,
        this.signer,
      );
      await ism.paused(); // Will succeed for pausable ISM
      return {
        type: IsmType.PAUSABLE,
        address,
      };
    } catch {
      return {
        type: IsmType.TRUSTED_RELAYER,
        address,
      };
    }
  }

  private async deriveMessageIdMultisigConfig(address: Address) {
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

  private async deriveMerkleRootMultisigConfig(address: Address) {
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

  private async deriveRoutingConfig(address: Address) {
    const ism = new Contract(
      this.getContractAbi(IsmType.ROUTING),
      address,
      this.signer,
    );

    const domains = await ism.domains();
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
    };
  }

  private async deriveFallbackRoutingConfig(address: Address) {
    const ism = new Contract(
      this.getContractAbi(IsmType.FALLBACK_ROUTING),
      address,
      this.signer,
    );

    const domains = await ism.domains();
    const domainConfigs: Record<string, any> = {};
    const mailbox = await ism.mailbox();

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
      type: IsmType.FALLBACK_ROUTING,
      address,
      domains: domainConfigs,
      mailbox: num.toHex64(mailbox.toString()),
    };
  }

  private async deriveAggregationConfig(address: Address) {
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
        try {
          return await this.deriveIsmConfig(
            num.toHex64(moduleAddress.toString()),
          );
        } catch (error) {
          this.logger.error(
            `Failed to derive config for module ${moduleAddress}`,
            error,
          );
          return null;
        }
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
