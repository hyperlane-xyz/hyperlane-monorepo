import {
  address as parseAddress,
  type Rpc,
  type SolanaRpcApi,
} from '@solana/kit';

import { HookType } from '@hyperlane-xyz/provider-sdk/altvm';
import {
  type ArtifactDeployed,
  type ArtifactNew,
  type ArtifactReader,
  ArtifactState,
  type ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import type { MerkleTreeHookConfig } from '@hyperlane-xyz/provider-sdk/hook';

import { assert } from '@hyperlane-xyz/utils';

import type { SvmSigner } from '../clients/signer.js';
import type {
  AnnotatedSvmTransaction,
  SvmDeployedHook,
  SvmReceipt,
} from '../types.js';

/**
 * Deployment-time configuration for the SVM merkle tree hook writer.
 * Passed to the writer constructor; separate from the on-chain artifact config.
 *
 * On SVM the merkle tree hook IS the mailbox program, so the writer only
 * needs the mailbox address to reference it — no separate deployment needed.
 */
export type SvmMerkleTreeHookWriterConfig = Readonly<{
  /** The already-deployed mailbox program address. */
  mailboxAddress: string;
}>;

export class SvmMerkleTreeHookReader implements ArtifactReader<
  MerkleTreeHookConfig,
  SvmDeployedHook
> {
  constructor(protected readonly _rpc: Rpc<SolanaRpcApi>) {}

  async read(
    address: string,
  ): Promise<ArtifactDeployed<MerkleTreeHookConfig, SvmDeployedHook>> {
    // On SVM the Merkle tree hook is the mailbox program itself.
    const programId = parseAddress(address);
    return {
      artifactState: ArtifactState.DEPLOYED,
      config: { type: HookType.MERKLE_TREE },
      deployed: { address: programId, programId },
    };
  }
}

export class SvmMerkleTreeHookWriter
  extends SvmMerkleTreeHookReader
  implements ArtifactWriter<MerkleTreeHookConfig, SvmDeployedHook>
{
  constructor(
    private readonly writerConfig: SvmMerkleTreeHookWriterConfig,
    rpc: Rpc<SolanaRpcApi>,
    protected readonly _signer: SvmSigner,
  ) {
    super(rpc);
  }

  async create(
    _artifact: ArtifactNew<MerkleTreeHookConfig>,
  ): Promise<
    [ArtifactDeployed<MerkleTreeHookConfig, SvmDeployedHook>, SvmReceipt[]]
  > {
    const programId = parseAddress(this.writerConfig.mailboxAddress);
    assert(programId, 'Merkle tree hook requires the mailbox address');

    return [
      {
        artifactState: ArtifactState.DEPLOYED,
        config: { type: HookType.MERKLE_TREE },
        deployed: { address: programId, programId },
      },
      [],
    ];
  }

  async update(
    _artifact: ArtifactDeployed<MerkleTreeHookConfig, SvmDeployedHook>,
  ): Promise<AnnotatedSvmTransaction[]> {
    return [];
  }
}
