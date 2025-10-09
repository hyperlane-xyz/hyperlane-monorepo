import { Address, AltVM, WithAddress, rootLogger } from '@hyperlane-xyz/utils';

import { ChainMetadataManager } from '../metadata/ChainMetadataManager.js';

import {
  DerivedHookConfig,
  HookConfig,
  HookType,
  IgpHookConfig,
  MerkleTreeHookConfig,
} from './types.js';

export class AltVMHookReader {
  protected readonly logger = rootLogger.child({
    module: 'AltVMHookReader',
  });

  constructor(
    protected readonly metadataManager: ChainMetadataManager,
    protected readonly provider: AltVM.IProvider,
  ) {}

  async deriveHookConfigFromAddress(
    address: Address,
  ): Promise<DerivedHookConfig> {
    try {
      const hook_type = await this.provider.getHookType({
        hookAddress: address,
      });

      switch (hook_type) {
        case AltVM.HookType.MERKLE_TREE:
          return this.deriveMerkleTreeConfig(address);
        case AltVM.HookType.INTERCHAIN_GAS_PAYMASTER:
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
      hookAddress: address,
    });

    const overhead: IgpHookConfig['overhead'] = {};
    const oracleConfig: IgpHookConfig['oracleConfig'] = {};

    Object.keys(igp.destinationGasConfigs).forEach((domain_id) => {
      const { name, nativeToken } =
        this.metadataManager.getChainMetadata(domain_id);
      overhead[name] = parseInt(
        igp.destinationGasConfigs[domain_id].gasOverhead,
      );
      oracleConfig[name] = {
        gasPrice:
          igp.destinationGasConfigs[domain_id].gasOracle?.gasPrice ?? '',
        tokenExchangeRate:
          igp.destinationGasConfigs[domain_id].gasOracle?.tokenExchangeRate ??
          '',
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
      hookAddress: address,
    });

    return {
      type: HookType.MERKLE_TREE,
      address: merkle_tree_hook.address,
    };
  }
}
