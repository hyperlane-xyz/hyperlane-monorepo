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

import type { SvmSigner } from '../signer.js';
import type {
  AnnotatedSvmTransaction,
  SvmDeployedHook,
  SvmProgramTarget,
  SvmReceipt,
} from '../types.js';

export interface SvmMerkleTreeHookConfig extends MerkleTreeHookConfig {
  program: SvmProgramTarget;
}

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
      config: { type: HookType.MERKLE_TREE as 'merkleTreeHook' },
      deployed: { address: programId, programId },
    };
  }
}

export class SvmMerkleTreeHookWriter
  extends SvmMerkleTreeHookReader
  implements ArtifactWriter<MerkleTreeHookConfig, SvmDeployedHook>
{
  constructor(
    rpc: Rpc<SolanaRpcApi>,
    protected readonly _signer: SvmSigner,
  ) {
    super(rpc);
  }

  async create(
    artifact: ArtifactNew<MerkleTreeHookConfig>,
  ): Promise<
    [ArtifactDeployed<MerkleTreeHookConfig, SvmDeployedHook>, SvmReceipt[]]
  > {
    const config = artifact.config as SvmMerkleTreeHookConfig;
    if (!('programId' in config.program)) {
      throw new Error(
        'Merkle tree hook requires an existing mailbox programId',
      );
    }
    const programId = config.program.programId;

    return [
      {
        artifactState: ArtifactState.DEPLOYED,
        config: { type: HookType.MERKLE_TREE as 'merkleTreeHook' },
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
