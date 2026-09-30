import { type DeliverTxResponse } from '@cosmjs/stargate';

import { IsmType } from '@hyperlane-xyz/provider-sdk/altvm';
import {
  type ArtifactDeployed,
  type ArtifactNew,
  type ArtifactReader,
  ArtifactState,
  type ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  type DeployedIsmAddress,
  type MerkleRootMultisigIsmConfig,
  type MessageIdMultisigIsmConfig,
} from '@hyperlane-xyz/provider-sdk/ism';

import { type CosmosNativeSigner } from '../clients/signer.js';
import { getNewContractAddress } from '../utils/base.js';
import { type AnnotatedEncodeObject } from '../utils/types.js';

import {
  type CosmosIsmQueryClient,
  getMerkleRootMultisigIsmConfig,
  getMessageIdMultisigIsmConfig,
} from './ism-query.js';
import {
  getCreateMerkleRootMultisigIsmTx,
  getCreateMessageIdMultisigIsmTx,
} from './ism-tx.js';

/**
 * Reader for Cosmos Message ID Multisig ISM.
 * Uses message IDs for validator signature verification.
 */
export class CosmosMessageIdMultisigIsmReader implements ArtifactReader<
  MessageIdMultisigIsmConfig,
  DeployedIsmAddress
> {
  constructor(private readonly query: CosmosIsmQueryClient) {}

  async read(
    address: string,
  ): Promise<ArtifactDeployed<MessageIdMultisigIsmConfig, DeployedIsmAddress>> {
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
 * Writer for Cosmos Message ID Multisig ISM.
 * Handles deployment of message ID multisig ISMs.
 */
export class CosmosMessageIdMultisigIsmWriter
  extends CosmosMessageIdMultisigIsmReader
  implements ArtifactWriter<MessageIdMultisigIsmConfig, DeployedIsmAddress>
{
  constructor(
    query: CosmosIsmQueryClient,
    private readonly signer: CosmosNativeSigner,
  ) {
    super(query);
  }

  async create(
    artifact: ArtifactNew<MessageIdMultisigIsmConfig>,
  ): Promise<
    [
      ArtifactDeployed<MessageIdMultisigIsmConfig, DeployedIsmAddress>,
      DeliverTxResponse[],
    ]
  > {
    const { config } = artifact;

    const transaction = await getCreateMessageIdMultisigIsmTx(
      this.signer.getSignerAddress(),
      {
        validators: config.validators,
        threshold: config.threshold,
      },
    );

    const receipt = await this.signer.sendAndConfirmTransaction(transaction);
    const ismAddress = getNewContractAddress(receipt);

    const deployedArtifact: ArtifactDeployed<
      MessageIdMultisigIsmConfig,
      DeployedIsmAddress
    > = {
      artifactState: ArtifactState.DEPLOYED,
      config: artifact.config,
      deployed: {
        address: ismAddress,
      },
    };

    return [deployedArtifact, [receipt]];
  }

  async update(
    _artifact: ArtifactDeployed<MessageIdMultisigIsmConfig, DeployedIsmAddress>,
  ): Promise<AnnotatedEncodeObject[]> {
    // Multisig ISMs are immutable.
    // To change configuration, a new ISM must be deployed
    return [];
  }
}

/**
 * Reader for Cosmos Merkle Root Multisig ISM.
 * Uses merkle root proofs for validator signature verification.
 */
export class CosmosMerkleRootMultisigIsmReader implements ArtifactReader<
  MerkleRootMultisigIsmConfig,
  DeployedIsmAddress
> {
  constructor(private readonly query: CosmosIsmQueryClient) {}

  async read(
    address: string,
  ): Promise<
    ArtifactDeployed<MerkleRootMultisigIsmConfig, DeployedIsmAddress>
  > {
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

/**
 * Writer for Cosmos Merkle Root Multisig ISM.
 * Handles deployment of merkle root multisig ISMs.
 */
export class CosmosMerkleRootMultisigIsmWriter
  extends CosmosMerkleRootMultisigIsmReader
  implements ArtifactWriter<MerkleRootMultisigIsmConfig, DeployedIsmAddress>
{
  constructor(
    query: CosmosIsmQueryClient,
    private readonly signer: CosmosNativeSigner,
  ) {
    super(query);
  }

  async create(
    artifact: ArtifactNew<MerkleRootMultisigIsmConfig>,
  ): Promise<
    [
      ArtifactDeployed<MerkleRootMultisigIsmConfig, DeployedIsmAddress>,
      DeliverTxResponse[],
    ]
  > {
    const { config } = artifact;

    const transaction = await getCreateMerkleRootMultisigIsmTx(
      this.signer.getSignerAddress(),
      {
        validators: config.validators,
        threshold: config.threshold,
      },
    );

    const receipt = await this.signer.sendAndConfirmTransaction(transaction);
    const ismAddress = getNewContractAddress(receipt);

    const deployedArtifact: ArtifactDeployed<
      MerkleRootMultisigIsmConfig,
      DeployedIsmAddress
    > = {
      artifactState: ArtifactState.DEPLOYED,
      config: artifact.config,
      deployed: {
        address: ismAddress,
      },
    };

    return [deployedArtifact, [receipt]];
  }

  async update(
    _artifact: ArtifactDeployed<
      MerkleRootMultisigIsmConfig,
      DeployedIsmAddress
    >,
  ): Promise<AnnotatedEncodeObject[]> {
    // Multisig ISMs are immutable.
    // To change configuration, a new ISM must be deployed
    return [];
  }
}
