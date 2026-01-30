import { type DeliverTxResponse } from '@cosmjs/stargate';

import { AltVM } from '@hyperlane-xyz/provider-sdk';
import {
  type ArtifactDeployed,
  type ArtifactNew,
  type ArtifactReader,
  ArtifactState,
  type ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  type DeployedHookAddress,
  type MerkleTreeHookConfig,
} from '@hyperlane-xyz/provider-sdk/hook';

import { type CosmosNativeSigner } from '../clients/signer.js';
import { getNewContractAddress } from '../utils/base.js';
import { type AnnotatedEncodeObject } from '../utils/types.js';

import {
  type CosmosHookQueryClient,
  getMerkleTreeHookConfig,
} from './hook-query.js';
import { getCreateMerkleTreeHookTx } from './hook-tx.js';

/**
 * Reader for Cosmos MerkleTree Hook.
 * Reads deployed MerkleTree hook configuration from the chain.
 * MerkleTree hooks are immutable once deployed.
 */
export class CosmosMerkleTreeHookReader implements ArtifactReader<
  MerkleTreeHookConfig,
  DeployedHookAddress
> {
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

/**
 * Writer for Cosmos MerkleTree Hook.
 * Handles deployment of MerkleTree hooks.
 * MerkleTree hooks are immutable, so no update operations are needed.
 */
export class CosmosMerkleTreeHookWriter
  extends CosmosMerkleTreeHookReader
  implements ArtifactWriter<MerkleTreeHookConfig, DeployedHookAddress>
{
  constructor(
    query: CosmosHookQueryClient,
    private readonly signer: CosmosNativeSigner,
    private readonly mailboxAddress: string,
  ) {
    super(query);
  }

  async create(
    artifact: ArtifactNew<MerkleTreeHookConfig>,
  ): Promise<
    [
      ArtifactDeployed<MerkleTreeHookConfig, DeployedHookAddress>,
      DeliverTxResponse[],
    ]
  > {
    const createTx = getCreateMerkleTreeHookTx(
      this.signer.getSignerAddress(),
      this.mailboxAddress,
    );

    const receipt = await this.signer.sendAndConfirmTransaction(createTx);
    const address = getNewContractAddress(receipt);

    const deployedArtifact: ArtifactDeployed<
      MerkleTreeHookConfig,
      DeployedHookAddress
    > = {
      artifactState: ArtifactState.DEPLOYED,
      config: artifact.config,
      deployed: {
        address,
      },
    };

    return [deployedArtifact, [receipt]];
  }

  async update(
    _artifact: ArtifactDeployed<MerkleTreeHookConfig, DeployedHookAddress>,
  ): Promise<AnnotatedEncodeObject[]> {
    // MerkleTreeHook has no mutable state
    return [];
  }
}
