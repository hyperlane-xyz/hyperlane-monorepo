import { IsmType } from '@hyperlane-xyz/provider-sdk/altvm';
import {
  ArtifactDeployed,
  ArtifactReader,
  ArtifactState,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  DeployedIsmAddresses,
  MultisigIsmConfig,
} from '@hyperlane-xyz/provider-sdk/ism';

import {
  CosmosIsmQueryClient,
  getMerkleRootMultisigIsmConfig,
  getMessageIdMultisigIsmConfig,
} from './ism-query.js';

/**
 * Reader for Cosmos Message ID Multisig ISM.
 * Uses message IDs for validator signature verification.
 */
export class CosmosMessageIdMultisigIsmReader
  implements ArtifactReader<MultisigIsmConfig, DeployedIsmAddresses>
{
  constructor(private readonly query: CosmosIsmQueryClient) {}

  async read(
    address: string,
  ): Promise<ArtifactDeployed<MultisigIsmConfig, DeployedIsmAddresses>> {
    const ismConfig = await getMessageIdMultisigIsmConfig(this.query, address);

    return {
      artifactState: ArtifactState.DEPLOYED,
      config: {
        type: IsmType.MESSAGE_ID_MULTISIG,
        validators: ismConfig.validators,
        threshold: ismConfig.threshold,
      },
      deployed: {
        address: ismConfig.address,
      },
    };
  }
}

/**
 * Reader for Cosmos Merkle Root Multisig ISM.
 * Uses merkle root proofs for validator signature verification.
 */
export class CosmosMerkleRootMultisigIsmReader
  implements ArtifactReader<MultisigIsmConfig, DeployedIsmAddresses>
{
  constructor(private readonly query: CosmosIsmQueryClient) {}

  async read(
    address: string,
  ): Promise<ArtifactDeployed<MultisigIsmConfig, DeployedIsmAddresses>> {
    const ismConfig = await getMerkleRootMultisigIsmConfig(this.query, address);

    return {
      artifactState: ArtifactState.DEPLOYED,
      config: {
        type: IsmType.MERKLE_ROOT_MULTISIG,
        validators: ismConfig.validators,
        threshold: ismConfig.threshold,
      },
      deployed: {
        address: ismConfig.address,
      },
    };
  }
}
