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

export class SvmMerkleTreeHookReader implements ArtifactReader<
  MerkleTreeHookConfig,
  DeployedHookAddress
> {
  constructor(
    protected readonly _rpc: Rpc<SolanaRpcApi>,
    protected readonly mailboxAddress: Address,
  ) {}

  async read(
    _address: string,
  ): Promise<ArtifactDeployed<MerkleTreeHookConfig, DeployedHookAddress>> {
    // On SVM the Merkle tree hook is the mailbox program itself.
    // The caller-supplied address is validated upstream (readHook asserts
    // it equals the configured mailbox); use the typed mailboxAddress here.
    return {
      artifactState: ArtifactState.DEPLOYED,
      config: { type: HookType.MERKLE_TREE as 'merkleTreeHook' },
      deployed: { address: this.mailboxAddress },
    };
  }
}

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
    return [
      {
        artifactState: ArtifactState.DEPLOYED,
        config: { type: HookType.MERKLE_TREE as 'merkleTreeHook' },
        deployed: { address: this.mailboxAddress },
      },
      [],
    ];
  }

  async update(
    _artifact: ArtifactDeployed<MerkleTreeHookConfig, DeployedHookAddress>,
  ): Promise<AnnotatedSvmTransaction[]> {
    return [];
  }
}
