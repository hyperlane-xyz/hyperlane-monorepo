import type {
  ArtifactReader,
  ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import type {
  DeployedMailboxAddress,
  DeployedRawMailboxArtifact,
  IRawMailboxArtifactManager,
  MailboxType,
  RawMailboxArtifactConfigs,
} from '@hyperlane-xyz/provider-sdk/mailbox';

import type { SvmSigner } from '../clients/signer.js';
import { HYPERLANE_SVM_PROGRAM_BYTES } from '../hyperlane/program-bytes.js';
import type { SvmRpc } from '../types.js';

import { SvmMailboxReader, SvmMailboxWriter } from './mailbox.js';

export class SvmMailboxArtifactManager implements IRawMailboxArtifactManager {
  constructor(
    private readonly rpc: SvmRpc,
    private readonly domainId: number,
  ) {}

  async readMailbox(address: string): Promise<DeployedRawMailboxArtifact> {
    const reader = this.createReader('mailbox');
    return reader.read(address);
  }

  createReader<T extends MailboxType>(
    _type: T,
  ): ArtifactReader<RawMailboxArtifactConfigs[T], DeployedMailboxAddress> {
    return new SvmMailboxReader(this.rpc);
  }

  createWriter<T extends MailboxType>(
    _type: T,
    signer: SvmSigner,
  ): ArtifactWriter<RawMailboxArtifactConfigs[T], DeployedMailboxAddress> {
    return new SvmMailboxWriter(
      {
        program: { programBytes: HYPERLANE_SVM_PROGRAM_BYTES.mailbox },
        domainId: this.domainId,
      },
      this.rpc,
      signer,
    );
  }
}
