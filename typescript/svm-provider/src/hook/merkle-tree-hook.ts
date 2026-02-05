import type { Address, Rpc, SolanaRpcApi } from '@solana/kit';

import { HookType } from '@hyperlane-xyz/provider-sdk/altvm';
import {
  type ArtifactDeployed,
  type ArtifactNew,
  type ArtifactReader,
  ArtifactState,
  type ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import type {
  DeployedHookAddress,
  MerkleTreeHookConfig,
} from '@hyperlane-xyz/provider-sdk/hook';

import type { SvmSigner } from '../signer.js';
import type { AnnotatedSvmTransaction, SvmReceipt } from '../types.js';

/**
 * Reader for SVM Merkle Tree Hook.
 *
 * On Solana, the merkle tree is **built into the mailbox** (outbox account).
 * There is no separate merkle tree hook program.
 *
 * The "address" returned is the mailbox address.
 */
export class SvmMerkleTreeHookReader
  implements ArtifactReader<MerkleTreeHookConfig, DeployedHookAddress>
{
  constructor(
    protected readonly _rpc: Rpc<SolanaRpcApi>,
    protected readonly mailboxAddress: Address,
  ) {}

  async read(
    address: string,
  ): Promise<ArtifactDeployed<MerkleTreeHookConfig, DeployedHookAddress>> {
    // The merkle tree hook is the mailbox itself on Solana
    return {
      artifactState: ArtifactState.DEPLOYED,
      config: {
        type: HookType.MERKLE_TREE as 'merkleTreeHook',
      },
      deployed: {
        address: address || this.mailboxAddress,
      },
    };
  }
}

/**
 * Writer for SVM Merkle Tree Hook.
 *
 * On Solana, the merkle tree is part of the mailbox. There's nothing to deploy -
 * this writer just returns the mailbox address as the "hook address".
 */
export class SvmMerkleTreeHookWriter
  extends SvmMerkleTreeHookReader
  implements ArtifactWriter<MerkleTreeHookConfig, DeployedHookAddress>
{
  constructor(
    rpc: Rpc<SolanaRpcApi>,
    mailboxAddress: Address,
    protected readonly _signer: SvmSigner,
  ) {
    super(rpc, mailboxAddress);
  }

  async create(
    _artifact: ArtifactNew<MerkleTreeHookConfig>,
  ): Promise<
    [ArtifactDeployed<MerkleTreeHookConfig, DeployedHookAddress>, SvmReceipt[]]
  > {
    // No deployment needed - merkle tree is part of mailbox
    const deployedArtifact: ArtifactDeployed<
      MerkleTreeHookConfig,
      DeployedHookAddress
    > = {
      artifactState: ArtifactState.DEPLOYED,
      config: {
        type: HookType.MERKLE_TREE as 'merkleTreeHook',
      },
      deployed: {
        address: this.mailboxAddress,
      },
    };

    // Return empty receipts since no transactions were made
    return [deployedArtifact, []];
  }

  async update(
    _artifact: ArtifactDeployed<MerkleTreeHookConfig, DeployedHookAddress>,
  ): Promise<AnnotatedSvmTransaction[]> {
    // Merkle tree hook is immutable (part of mailbox)
    return [];
  }
}
