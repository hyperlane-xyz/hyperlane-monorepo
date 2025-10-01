import {
  Address,
  MultiVM,
  WithAddress,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { ChainMetadataManager } from '../metadata/ChainMetadataManager.js';

import {
  DerivedHookConfig,
  HookConfig,
  HookType,
  IgpHookConfig,
  MerkleTreeHookConfig,
} from './types.js';

export class MultiVmHookReader {
  protected readonly logger = rootLogger.child({
    module: 'MultiVmHookReader',
  });

  constructor(
    protected readonly metadataManager: ChainMetadataManager,
    protected readonly provider: MultiVM.IMultiVMProvider,
  ) {}

  async deriveHookConfigFromAddress(
    address: Address,
  ): Promise<DerivedHookConfig> {
    try {
      const hook_type = await this.provider.getHookType({ hook_id: address });

      switch (hook_type) {
        case MultiVM.HookType.MERKLE_TREE_HOOK:
          return this.deriveMerkleTreeConfig(address);
        case MultiVM.HookType.INTERCHAIN_GAS_PAYMASTER:
          return this.deriveIgpConfig(address);
        default:
          throw new Error(`Unknown Hook Type: ${hook_type}`);
      }
    } catch (error) {
      this.logger.error(`Failed to derive Hook config for ${address}`, error);
      throw error;
    }
  }

  async deriveHookConfig(config: HookConfig): Promise<DerivedHookConfig> {
    if (typeof config === 'string')
      return this.deriveHookConfigFromAddress(config);

    return config as DerivedHookConfig;
  }

  private async deriveIgpConfig(
    address: Address,
  ): Promise<WithAddress<IgpHookConfig>> {
    const igp = await this.provider.getInterchainGasPaymasterHook({
      hook_id: address,
    });

    const overhead: IgpHookConfig['overhead'] = {};
    const oracleConfig: IgpHookConfig['oracleConfig'] = {};

    Object.keys(igp.destination_gas_configs).forEach((domain_id) => {
      const { name, nativeToken } =
        this.metadataManager.getChainMetadata(domain_id);
      overhead[name] = parseInt(
        igp.destination_gas_configs[domain_id].gas_overhead,
      );
      oracleConfig[name] = {
        gasPrice:
          igp.destination_gas_configs[domain_id].gas_oracle?.gas_price ?? '',
        tokenExchangeRate:
          igp.destination_gas_configs[domain_id].gas_oracle
            ?.token_exchange_rate ?? '',
        tokenDecimals: nativeToken?.decimals,
      };
    });

    return {
      type: HookType.INTERCHAIN_GAS_PAYMASTER,
      owner: igp.owner,
      beneficiary: igp.owner,
      oracleKey: igp.owner,
      overhead,
      oracleConfig,
      address: igp.address,
    };
  }

  private async deriveMerkleTreeConfig(
    address: Address,
  ): Promise<WithAddress<MerkleTreeHookConfig>> {
    const merkle_tree_hook = await this.provider.getMerkleTreeHook({
      hook_id: address,
    });

    return {
      type: HookType.MERKLE_TREE,
      address: merkle_tree_hook.address,
    };
  }
}
