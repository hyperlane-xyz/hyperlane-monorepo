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

import { type TronSigner } from '../clients/signer.js';
import { TronReceipt, TronTransaction } from '../utils/types.js';

import {
  type TronHookQueryClient,
  getMerkleTreeHookConfig,
} from './hook-query.js';
import { getCreateMerkleTreeHookTx } from './hook-tx.js';

/**
 * Reader for Tron MerkleTree Hook.
 * Reads deployed MerkleTree hook configuration from the chain.
 * MerkleTree hooks are immutable once deployed.
 */
export class TronMerkleTreeHookReader
  implements ArtifactReader<MerkleTreeHookConfig, DeployedHookAddress>
{
  constructor(private readonly query: TronHookQueryClient) {}

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
 * Writer for Tron MerkleTree Hook.
 * Handles deployment of MerkleTree hooks.
 * MerkleTree hooks are immutable, so no update operations are needed.
 */
export class TronMerkleTreeHookWriter
  extends TronMerkleTreeHookReader
  implements ArtifactWriter<MerkleTreeHookConfig, DeployedHookAddress>
{
  constructor(
    query: TronHookQueryClient,
    private readonly signer: TronSigner,
    private readonly mailboxAddress: string,
  ) {
    super(query);
  }

  async create(
    artifact: ArtifactNew<MerkleTreeHookConfig>,
  ): Promise<
    [ArtifactDeployed<MerkleTreeHookConfig, DeployedHookAddress>, TronReceipt[]]
  > {
    const createTx = await getCreateMerkleTreeHookTx(
      this.signer.getTronweb(),
      this.signer.getSignerAddress(),
      this.mailboxAddress,
    );

    const receipt = await this.signer.sendAndConfirmTransaction(createTx);
    const hookAddress = this.signer
      .getTronweb()
      .address.fromHex(receipt.contract_address);

    const deployedArtifact: ArtifactDeployed<
      MerkleTreeHookConfig,
      DeployedHookAddress
    > = {
      artifactState: ArtifactState.DEPLOYED,
      config: artifact.config,
      deployed: {
        address: hookAddress,
      },
    };

    return [deployedArtifact, [receipt]];
  }

  async update(
    _artifact: ArtifactDeployed<MerkleTreeHookConfig, DeployedHookAddress>,
  ): Promise<TronTransaction[]> {
    // MerkleTreeHook has no mutable state
    return [];
  }
}
