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

import { AnnotatedTx, TxReceipt } from '../../module.js';

/**
 * Reader for MerkleTree Hook.
 * Reads deployed MerkleTree hook configuration from the chain.
 * MerkleTree hooks are immutable once deployed.
 */
export class MerkleTreeHookReader
  implements ArtifactReader<MerkleTreeHookConfig, DeployedHookAddress>
{
  constructor(protected readonly provider: AltVM.IProvider) {}

  async read(
    address: string,
  ): Promise<ArtifactDeployed<MerkleTreeHookConfig, DeployedHookAddress>> {
    const hookConfig = await this.provider.getMerkleTreeHook({
      hookAddress: address,
    });

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
 * Writer for  MerkleTree Hook.
 * Handles deployment of MerkleTree hooks.
 * MerkleTree hooks are immutable, so no update operations are needed.
 */
export class MerkleTreeHookWriter
  extends MerkleTreeHookReader
  implements ArtifactWriter<MerkleTreeHookConfig, DeployedHookAddress>
{
  constructor(
    provider: AltVM.IProvider,
    private readonly signer: AltVM.ISigner<AnnotatedTx, TxReceipt>,
    private readonly mailboxAddress: string,
  ) {
    super(provider);
  }

  async create(
    artifact: ArtifactNew<MerkleTreeHookConfig>,
  ): Promise<
    [ArtifactDeployed<MerkleTreeHookConfig, DeployedHookAddress>, TxReceipt[]]
  > {
    const { hookAddress, receipts } = await this.signer.createMerkleTreeHook({
      mailboxAddress: this.mailboxAddress,
    });

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

    return [deployedArtifact, receipts];
  }

  async update(
    _artifact: ArtifactDeployed<MerkleTreeHookConfig, DeployedHookAddress>,
  ): Promise<AnnotatedTx[]> {
    // MerkleTreeHook has no mutable state
    return [];
  }
}
