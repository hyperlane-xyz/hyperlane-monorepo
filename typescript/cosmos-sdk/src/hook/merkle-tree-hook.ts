import { AltVM } from '@hyperlane-xyz/provider-sdk';
import {
  ArtifactDeployed,
  ArtifactReader,
  ArtifactState,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  DeployedHookAddress,
  MerkleTreeHookConfig,
} from '@hyperlane-xyz/provider-sdk/hook';

import {
  CosmosHookQueryClient,
  getMerkleTreeHookConfig,
} from './hook-query.js';

/**
 * Reader for Cosmos MerkleTree Hook.
 * Reads deployed MerkleTree hook configuration from the chain.
 * MerkleTree hooks are immutable once deployed.
 */
export class CosmosMerkleTreeHookReader
  implements ArtifactReader<MerkleTreeHookConfig, DeployedHookAddress>
{
  constructor(private readonly query: CosmosHookQueryClient) {}

  async read(
    address: string,
  ): Promise<ArtifactDeployed<MerkleTreeHookConfig, DeployedHookAddress>> {
    const hookConfig = await getMerkleTreeHookConfig(this.query, address);

    return {
      artifactState: ArtifactState.DEPLOYED,
      config: {
        type: AltVM.HookType.MERKLE_TREE,
      },
      deployed: {
        address: hookConfig.address,
      },
    };
  }
}
