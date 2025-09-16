import { RadixSDK, RadixSigningSDK } from '@hyperlane-xyz/radix-sdk';
import { Address, WithAddress, assert, rootLogger } from '@hyperlane-xyz/utils';

import { ChainMetadataManager } from '../metadata/ChainMetadataManager.js';

import {
  DerivedHookConfig,
  HookType,
  IgpHookConfig,
  MerkleTreeHookConfig,
} from './types.js';

export class RadixHookReader {
  protected readonly logger = rootLogger.child({
    module: 'RadixHookReader',
  });

  constructor(
    protected readonly metadataManager: ChainMetadataManager,
    protected readonly sdk: RadixSDK | RadixSigningSDK,
  ) {}

  async deriveHookConfig(address: Address): Promise<DerivedHookConfig> {
    const hookType = await this.deriveHookType(address);

    switch (hookType) {
      case HookType.INTERCHAIN_GAS_PAYMASTER: {
        return this.deriveIgpConfig(address);
      }
      case HookType.MERKLE_TREE: {
        return this.deriveMerkleTreeConfig(address);
      }
      default: {
        throw new Error(`Unsupported hook type for address: ${address}`);
      }
    }
  }

  private async deriveIgpConfig(
    address: Address,
  ): Promise<WithAddress<IgpHookConfig>> {
    const igp = await this.sdk.query.core.getIgpHook({ hook: address });

    assert(igp, `IGP not found for address ${address}`);

    const overhead: IgpHookConfig['overhead'] = {};
    const oracleConfig: IgpHookConfig['oracleConfig'] = {};

    Object.keys(igp.destination_gas_configs).forEach((remoteDomain) => {
      const { name, nativeToken } =
        this.metadataManager.getChainMetadata(remoteDomain);

      const gasConfig = igp.destination_gas_configs[remoteDomain];

      overhead[name] = parseInt(gasConfig?.gas_overhead ?? '');
      oracleConfig[name] = {
        gasPrice: gasConfig?.gas_oracle?.gas_price ?? '',
        tokenExchangeRate: gasConfig?.gas_oracle?.token_exchange_rate ?? '',
        tokenDecimals: gasConfig ? nativeToken?.decimals : 0,
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
    const merkleTreeHook = await this.sdk.query.core.getMerkleTreeHook({
      hook: address,
    });

    assert(merkleTreeHook, `Merkle Tree Hook not found for address ${address}`);

    return {
      type: HookType.MERKLE_TREE,
      address: merkleTreeHook.address,
    };
  }

  private async deriveHookType(address: Address): Promise<HookType> {
    try {
      const igp = await this.sdk.query.core.getIgpHook({ hook: address });
      if (!!igp) {
        return HookType.INTERCHAIN_GAS_PAYMASTER;
      }
    } catch {}

    try {
      const igp = await this.sdk.query.core.getMerkleTreeHook({
        hook: address,
      });
      if (!!igp) {
        return HookType.MERKLE_TREE;
      }
    } catch {}

    throw new Error(`Unsupported hook type for address: ${address}`);
  }
}
