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

import { AnyAleoNetworkClient } from '../clients/base.js';

import { getMerkleTreeHookConfig } from './hook-query.js';

export class AleoMerkleTreeHookReader
  implements ArtifactReader<MerkleTreeHookConfig, DeployedHookAddress>
{
  constructor(private readonly aleoClient: AnyAleoNetworkClient) {}

  async read(
    address: string,
  ): Promise<ArtifactDeployed<MerkleTreeHookConfig, DeployedHookAddress>> {
    const hookConfig = await getMerkleTreeHookConfig(this.aleoClient, address);

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
