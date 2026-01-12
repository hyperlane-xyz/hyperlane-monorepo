import { EncodeObject } from '@cosmjs/proto-signing';
import { DeliverTxResponse } from '@cosmjs/stargate';

import { IsmType } from '@hyperlane-xyz/provider-sdk/altvm';
import {
  ArtifactDeployed,
  ArtifactNew,
  ArtifactReader,
  ArtifactState,
  ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  DeployedIsmAddress,
  MultisigIsmConfig,
} from '@hyperlane-xyz/provider-sdk/ism';

import { CosmosNativeSigner } from '../clients/signer.js';

import {
  CosmosIsmQueryClient,
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
export class CosmosMessageIdMultisigIsmReader
  implements ArtifactReader<MultisigIsmConfig, DeployedIsmAddress>
{
  constructor(private readonly query: CosmosIsmQueryClient) {}

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
 * Writer for Cosmos Message ID Multisig ISM.
 * Handles deployment of message ID multisig ISMs.
 */
export class CosmosMessageIdMultisigIsmWriter
  extends CosmosMessageIdMultisigIsmReader
  implements ArtifactWriter<MultisigIsmConfig, DeployedIsmAddress>
{
  constructor(
    query: CosmosIsmQueryClient,
    private readonly signer: CosmosNativeSigner,
  ) {
    super(query);
  }

  async create(
    artifact: ArtifactNew<MultisigIsmConfig>,
  ): Promise<
    [
      ArtifactDeployed<MultisigIsmConfig, DeployedIsmAddress>,
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

    const { id, receipt } = await this.signer.submitTxWithReceipt(transaction);

    const deployedArtifact: ArtifactDeployed<
      MultisigIsmConfig,
      DeployedIsmAddress
    > = {
      artifactState: ArtifactState.DEPLOYED,
      config: artifact.config,
      deployed: {
        address: id,
      },
    };

    return [deployedArtifact, [receipt]];
  }

  async update(
    _artifact: ArtifactDeployed<MultisigIsmConfig, DeployedIsmAddress>,
  ): Promise<EncodeObject[]> {
    // Multisig ISMs are immutable.
    // To change configuration, a new ISM must be deployed
    return [];
  }
}

/**
 * Reader for Cosmos Merkle Root Multisig ISM.
 * Uses merkle root proofs for validator signature verification.
 */
export class CosmosMerkleRootMultisigIsmReader
  implements ArtifactReader<MultisigIsmConfig, DeployedIsmAddress>
{
  constructor(private readonly query: CosmosIsmQueryClient) {}

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

/**
 * Writer for Cosmos Merkle Root Multisig ISM.
 * Handles deployment of merkle root multisig ISMs.
 */
export class CosmosMerkleRootMultisigIsmWriter
  extends CosmosMerkleRootMultisigIsmReader
  implements ArtifactWriter<MultisigIsmConfig, DeployedIsmAddress>
{
  constructor(
    query: CosmosIsmQueryClient,
    private readonly signer: CosmosNativeSigner,
  ) {
    super(query);
  }

  async create(
    artifact: ArtifactNew<MultisigIsmConfig>,
  ): Promise<
    [
      ArtifactDeployed<MultisigIsmConfig, DeployedIsmAddress>,
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

    const { id, receipt } = await this.signer.submitTxWithReceipt(transaction);

    const deployedArtifact: ArtifactDeployed<
      MultisigIsmConfig,
      DeployedIsmAddress
    > = {
      artifactState: ArtifactState.DEPLOYED,
      config: artifact.config,
      deployed: {
        address: id,
      },
    };

    return [deployedArtifact, [receipt]];
  }

  async update(
    _artifact: ArtifactDeployed<MultisigIsmConfig, DeployedIsmAddress>,
  ): Promise<EncodeObject[]> {
    // Multisig ISMs are immutable.
    // To change configuration, a new ISM must be deployed
    return [];
  }
}
