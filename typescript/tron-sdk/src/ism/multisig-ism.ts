import { IsmType } from '@hyperlane-xyz/provider-sdk/altvm';
import {
  type ArtifactDeployed,
  type ArtifactReader,
  ArtifactState,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  type DeployedIsmAddress,
  type MultisigIsmConfig,
} from '@hyperlane-xyz/provider-sdk/ism';

import {
  type TronIsmQueryClient,
  getMerkleRootMultisigIsmConfig,
  getMessageIdMultisigIsmConfig,
} from './ism-query.js';

/**
 * Reader for Tron Message ID Multisig ISM.
 * Uses message IDs for validator signature verification.
 */
export class TronMessageIdMultisigIsmReader
  implements ArtifactReader<MultisigIsmConfig, DeployedIsmAddress>
{
  constructor(private readonly query: TronIsmQueryClient) {}

  async read(
    address: string,
  ): Promise<ArtifactDeployed<MultisigIsmConfig, DeployedIsmAddress>> {
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
 * Reader for Tron Merkle Root Multisig ISM.
 * Uses merkle root proofs for validator signature verification.
 */
export class TronMerkleRootMultisigIsmReader
  implements ArtifactReader<MultisigIsmConfig, DeployedIsmAddress>
{
  constructor(private readonly query: TronIsmQueryClient) {}

  async read(
    address: string,
  ): Promise<ArtifactDeployed<MultisigIsmConfig, DeployedIsmAddress>> {
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
