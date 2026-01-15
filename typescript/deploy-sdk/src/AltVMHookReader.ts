import { AltVM } from '@hyperlane-xyz/provider-sdk';
import { ChainMetadataLookup } from '@hyperlane-xyz/provider-sdk/chain';
import {
  DerivedHookConfig,
  HookConfig,
  HookModuleType,
  IgpHookModuleConfig,
  MerkleTreeHookConfig,
} from '@hyperlane-xyz/provider-sdk/hook';
import { HypReader } from '@hyperlane-xyz/provider-sdk/module';
import { Address, Logger, WithAddress, rootLogger } from '@hyperlane-xyz/utils';

export class AltVMHookReader implements HypReader<HookModuleType> {
  protected readonly logger: Logger = rootLogger.child({
    module: 'AltVMHookReader',
  });

  constructor(
    protected readonly getChainMetadata: ChainMetadataLookup,
    protected readonly provider: AltVM.IProvider,
  ) {}

  async read(address: string): Promise<DerivedHookConfig> {
    return this.deriveHookConfig(address);
  }

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

  async deriveHookConfig(
    config: HookConfig | Address,
  ): Promise<DerivedHookConfig> {
    if (typeof config === 'string')
      return this.deriveHookConfigFromAddress(config);

    return config as DerivedHookConfig;
  }

  private async deriveIgpConfig(
    address: Address,
  ): Promise<WithAddress<IgpHookModuleConfig>> {
    const igp = await this.provider.getInterchainGasPaymasterHook({
      hookAddress: address,
    });

    const overhead: IgpHookModuleConfig['overhead'] = {};
    const oracleConfig: IgpHookModuleConfig['oracleConfig'] = {};

    Object.keys(igp.destinationGasConfigs).forEach((domain_id) => {
      const { name, nativeToken } = this.getChainMetadata(domain_id);
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
      type: 'interchainGasPaymaster',
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
      type: 'merkleTreeHook',
      address: merkle_tree_hook.address,
    };
  }
}
