import { CairoCustomEnum, num } from 'starknet';

import {
  ChainNameOrId,
  StarknetIsmType,
  StarknetJsProvider,
  getStarknetContract,
} from '@hyperlane-xyz/sdk';
import { Address, WithAddress, rootLogger } from '@hyperlane-xyz/utils';

import { MultiProtocolProvider } from '../providers/MultiProtocolProvider.js';

import { StarknetIsmContractName } from './starknet-utils.js';
import {
  AggregationIsmConfig,
  DerivedIsmConfig,
  IsmType,
  MultisigIsmConfig,
  RoutingIsmConfig,
} from './types.js';

export class StarknetIsmReader {
  protected readonly logger = rootLogger.child({ module: 'StarknetIsmReader' });
  protected readonly provider: StarknetJsProvider['provider'];

  constructor(
    protected readonly multiProvider: MultiProtocolProvider,
    protected readonly chain: ChainNameOrId,
  ) {
    this.provider = multiProvider.getStarknetProvider(this.chain);
  }

  async deriveIsmConfig(address: Address): Promise<DerivedIsmConfig> {
    try {
      const ism = getStarknetContract(
        StarknetIsmContractName[IsmType.MERKLE_ROOT_MULTISIG], // fn module_type same across all isms
        address,
        this.provider,
      );

      const moduleType: CairoCustomEnum = await ism.module_type();
      const variant = moduleType.activeVariant();
      switch (variant) {
        case StarknetIsmType.AGGREGATION:
          return this.deriveAggregationConfig(address);
        case StarknetIsmType.CCIP_READ:
          throw new Error('CCIP_READ does not have a corresponding IsmType');
        case StarknetIsmType.LEGACY_MULTISIG:
          throw new Error('LEGACY_MULTISIG is deprecated and not supported');
        case StarknetIsmType.MERKLE_ROOT_MULTISIG:
          return this.deriveMerkleRootMultisigConfig(address);
        case StarknetIsmType.MESSAGE_ID_MULTISIG:
          return this.deriveMessageIdMultisigConfig(address);
        case StarknetIsmType.NULL:
          return this.deriveNullConfig(address);
        case StarknetIsmType.ROUTING:
          return this.deriveRoutingConfig(address);
        case StarknetIsmType.UNUSED:
          throw new Error('Error deriving NULL ISM type');
        default:
          throw new Error(`Unknown ISM ModuleType: ${variant}`);
      }
    } catch (error) {
      this.logger.error(`Failed to derive ISM config for ${address}`, error);
      throw error;
    }
  }

  private async deriveAggregationConfig(
    address: Address,
  ): Promise<WithAddress<AggregationIsmConfig>> {
    const ism = getStarknetContract(
      StarknetIsmContractName[IsmType.AGGREGATION],
      address,
      this.provider,
    );

    const [modules, threshold] = await Promise.all([
      ism.get_modules(),
      ism.get_threshold(),
    ]);

    const moduleConfigs = await Promise.all(
      modules.map(async (moduleAddress: any) => {
        return this.deriveIsmConfig(num.toHex64(moduleAddress.toString()));
      }),
    );

    return {
      type: IsmType.AGGREGATION,
      address,
      modules: moduleConfigs.filter(Boolean),
      threshold: threshold.toString(),
    };
  }

  private async deriveMerkleRootMultisigConfig(
    address: Address,
  ): Promise<WithAddress<MultisigIsmConfig>> {
    const ism = getStarknetContract(
      StarknetIsmContractName[IsmType.MERKLE_ROOT_MULTISIG],
      address,
      this.provider,
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

  private async deriveMessageIdMultisigConfig(
    address: Address,
  ): Promise<DerivedIsmConfig> {
    const ism = getStarknetContract(
      StarknetIsmContractName[IsmType.MESSAGE_ID_MULTISIG],
      address,
      this.provider,
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

  private async deriveNullConfig(address: Address): Promise<DerivedIsmConfig> {
    const trustedRelayerIsm = getStarknetContract(
      StarknetIsmContractName[IsmType.TRUSTED_RELAYER],
      address,
      this.provider,
    );

    try {
      const relayer = await trustedRelayerIsm.trusted_relayer();
      return {
        address,
        relayer,
        type: IsmType.TRUSTED_RELAYER,
      };
    } catch {
      this.logger.debug(
        'Error accessing "trusted_relayer" property, implying this is not a Trusted Relayer ISM.',
        address,
      );
    }

    const pausableIsm = getStarknetContract(
      StarknetIsmContractName[IsmType.PAUSABLE],
      address,
      this.provider,
    );
    try {
      const paused = await pausableIsm.is_paused();
      const owner = await pausableIsm.owner();
      return {
        address,
        paused,
        owner,
        type: IsmType.PAUSABLE,
      };
    } catch {
      this.logger.debug(
        'Error accessing "paused" or "owner" property, implying this is not a Pausable ISM.',
        address,
      );
    }

    return {
      type: IsmType.TEST_ISM,
      address,
    };
  }

  private async deriveRoutingConfig(
    address: Address,
  ): Promise<WithAddress<RoutingIsmConfig>> {
    const ism = getStarknetContract(
      StarknetIsmContractName[IsmType.ROUTING],
      address,
      this.provider,
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
}
