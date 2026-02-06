import {
  type ArtifactReader,
  type ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  type DeployedMailboxAddress,
  type IRawMailboxArtifactManager,
  type MailboxType,
  type RawMailboxArtifactConfigs,
} from '@hyperlane-xyz/provider-sdk/mailbox';
import { assert } from '@hyperlane-xyz/utils';

import { type AnyAleoNetworkClient } from '../clients/base.js';
import { type AleoSigner } from '../clients/signer.js';

import { AleoMailboxReader, AleoMailboxWriter } from './mailbox.js';

/**
 * Aleo Mailbox Artifact Manager implementing IRawMailboxArtifactManager.
 *
 * This manager:
 * - Provides factory methods for creating mailbox readers and writers
 * - Handles mailbox deployment and configuration
 */
export class AleoMailboxArtifactManager implements IRawMailboxArtifactManager {
  constructor(
    private readonly aleoClient: AnyAleoNetworkClient,
    private readonly domainId: number,
  ) {}

  async readMailbox(address: string) {
    const reader = this.createReader('mailbox');
    return reader.read(address);
  }

  createReader<T extends MailboxType>(
    type: T,
  ): ArtifactReader<RawMailboxArtifactConfigs[T], DeployedMailboxAddress> {
    const readers: {
      [K in MailboxType]: () => ArtifactReader<
        RawMailboxArtifactConfigs[K],
        DeployedMailboxAddress
      >;
    } = {
      mailbox: () => new AleoMailboxReader(this.aleoClient),
    };

    const maybeReader = readers[type]();

    assert(maybeReader, `Mailbox reader for ${type} not found`);
    return maybeReader;
  }

  createWriter<T extends MailboxType>(
    type: T,
    signer: AleoSigner,
  ): ArtifactWriter<RawMailboxArtifactConfigs[T], DeployedMailboxAddress> {
    const writers: {
      [K in MailboxType]: () => ArtifactWriter<
        RawMailboxArtifactConfigs[K],
        DeployedMailboxAddress
      >;
    } = {
      mailbox: () =>
        new AleoMailboxWriter(this.aleoClient, signer, this.domainId),
    };

    const maybeWriter = writers[type]();

    assert(maybeWriter, `Mailbox writer for ${type} not found`);
    return maybeWriter;
  }
}
