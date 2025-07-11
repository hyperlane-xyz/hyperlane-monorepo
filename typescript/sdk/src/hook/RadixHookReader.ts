import { RadixSDK, RadixSigningSDK } from '@hyperlane-xyz/radix-sdk';
import { Address, WithAddress, assert, rootLogger } from '@hyperlane-xyz/utils';

import { ChainMetadataManager } from '../metadata/ChainMetadataManager.js';
import { NativeToken } from '../metadata/chainMetadataTypes.js';

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
    try {
      if (await this.isIgpHook(address)) {
        return this.deriveIgpConfig(address);
      } else if (await this.isMerkleTreeHook(address)) {
        return this.deriveMerkleTreeConfig(address);
      } else {
        throw new Error(`Unsupported hook type for address: ${address}`);
      }
    } catch (error) {
      this.logger.error(`Failed to derive Hook config for ${address}`, error);
      throw error;
    }
  }

  private async deriveIgpConfig(
    address: Address,
  ): Promise<WithAddress<IgpHookConfig>> {
    const igp = await this.sdk.queryIgpHook(address);

    assert(igp, `IGP not found for address ${address}`);

    const overhead: IgpHookConfig['overhead'] = {};
    const oracleConfig: IgpHookConfig['oracleConfig'] = {};

    Object.keys(igp.destinationGasConfigs).forEach((domainId) => {
      let name = '';
      let nativeToken = {} as NativeToken;

      // TODO: RADIX
      // domain id 1337 does not exist but is hardcoded in the contracts for testing
      if (domainId === '1337') {
        const metadata = this.metadataManager.getChainMetadata('11155111');
        name = metadata.name;
        nativeToken = metadata.nativeToken || ({} as NativeToken);
      }

      const gasConfig = igp.destinationGasConfigs[domainId];

      overhead[name] = parseInt(gasConfig.gasOverhead);
      oracleConfig[name] = {
        gasPrice: gasConfig.gasOracle?.gasPrice ?? '',
        tokenExchangeRate: gasConfig.gasOracle?.tokenExchangeRate ?? '',
        tokenDecimals: nativeToken?.decimals,
      };
    });

    // TODO: RADIX
    // get beneficiary and oracleKey once implemented

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
    const merkleTreeHook = await this.sdk.queryMerkleTreeHook(address);

    assert(merkleTreeHook, `Merkle Tree Hook not found for address ${address}`);

    return {
      type: HookType.MERKLE_TREE,
      address: merkleTreeHook.address,
    };
  }

  private async isIgpHook(address: Address): Promise<boolean> {
    try {
      const igp = await this.sdk.queryIgpHook(address);
      return !!igp;
    } catch {
      return false;
    }
  }

  private async isMerkleTreeHook(address: Address): Promise<boolean> {
    try {
      const merkleTreeHook = await this.sdk.queryMerkleTreeHook(address);
      return !!merkleTreeHook;
    } catch {
      return false;
    }
  }
}
