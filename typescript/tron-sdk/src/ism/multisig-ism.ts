import { IsmType } from '@hyperlane-xyz/provider-sdk/altvm';
import {
  type ArtifactDeployed,
  ArtifactNew,
  type ArtifactReader,
  ArtifactState,
  ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  type DeployedIsmAddress,
  type MultisigIsmConfig,
} from '@hyperlane-xyz/provider-sdk/ism';

import { TronSigner } from '../clients/signer.js';
import { TronReceipt, TronTransaction } from '../utils/types.js';

import {
  type TronIsmQueryClient,
  getMerkleRootMultisigIsmConfig,
  getMessageIdMultisigIsmConfig,
} from './ism-query.js';
import {
  getCreateMerkleRootMultisigIsmTx,
  getCreateMessageIdMultisigIsmTx,
} from './ism-tx.js';

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
 * Writer for Tron Message ID Multisig ISM.
 * Handles deployment of message ID multisig ISMs.
 */
export class TronMessageIdMultisigIsmWriter
  extends TronMessageIdMultisigIsmReader
  implements ArtifactWriter<MultisigIsmConfig, DeployedIsmAddress>
{
  constructor(
    query: TronIsmQueryClient,
    private readonly signer: TronSigner,
  ) {
    super(query);
  }

  async create(
    artifact: ArtifactNew<MultisigIsmConfig>,
  ): Promise<
    [ArtifactDeployed<MultisigIsmConfig, DeployedIsmAddress>, TronReceipt[]]
  > {
    const { config } = artifact;

    const transaction = await getCreateMessageIdMultisigIsmTx(
      this.signer.getTronweb(),
      this.signer.getSignerAddress(),
      {
        validators: config.validators,
        threshold: config.threshold,
      },
    );

    const receipt = await this.signer.sendAndConfirmTransaction(transaction);
    const ismAddress = this.signer
      .getTronweb()
      .address.fromHex(receipt.contract_address);

    const deployedArtifact: ArtifactDeployed<
      MultisigIsmConfig,
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
    _artifact: ArtifactDeployed<MultisigIsmConfig, DeployedIsmAddress>,
  ): Promise<TronTransaction[]> {
    // Multisig ISMs are immutable.
    // To change configuration, a new ISM must be deployed
    return [];
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

/**
 * Writer for Tron Merkle Root Multisig ISM.
 * Handles deployment of merkle root multisig ISMs.
 */
export class TronMerkleRootMultisigIsmWriter
  extends TronMerkleRootMultisigIsmReader
  implements ArtifactWriter<MultisigIsmConfig, DeployedIsmAddress>
{
  constructor(
    query: TronIsmQueryClient,
    private readonly signer: TronSigner,
  ) {
    super(query);
  }

  async create(
    artifact: ArtifactNew<MultisigIsmConfig>,
  ): Promise<
    [ArtifactDeployed<MultisigIsmConfig, DeployedIsmAddress>, TronReceipt[]]
  > {
    const { config } = artifact;

    const transaction = await getCreateMerkleRootMultisigIsmTx(
      this.signer.getTronweb(),
      this.signer.getSignerAddress(),
      {
        validators: config.validators,
        threshold: config.threshold,
      },
    );

    const receipt = await this.signer.sendAndConfirmTransaction(transaction);
    const ismAddress = this.signer
      .getTronweb()
      .address.fromHex(receipt.contract_address);

    const deployedArtifact: ArtifactDeployed<
      MultisigIsmConfig,
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
    _artifact: ArtifactDeployed<MultisigIsmConfig, DeployedIsmAddress>,
  ): Promise<TronTransaction[]> {
    // Multisig ISMs are immutable.
    // To change configuration, a new ISM must be deployed
    return [];
  }
}
