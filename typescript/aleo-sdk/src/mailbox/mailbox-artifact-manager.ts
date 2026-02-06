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
import { MAINNET_PREFIX, TESTNET_PREFIX } from '../utils/helper.js';
import { type OnChainArtifactManagers } from '../utils/types.js';

import { AleoMailboxReader, AleoMailboxWriter } from './mailbox.js';

/**
 * Aleo Mailbox Artifact Manager implementing IRawMailboxArtifactManager.
 *
 * This manager:
 * - Provides factory methods for creating mailbox readers and writers
 * - Handles mailbox deployment and configuration
 */
export class AleoMailboxArtifactManager implements IRawMailboxArtifactManager {
  private readonly onChainArtifactManagers: OnChainArtifactManagers;

  constructor(
    private readonly aleoClient: AnyAleoNetworkClient,
    private readonly domainId: number,
    chainId: number,
  ) {
    // Determine prefix from chain ID
    const prefix = chainId === 1 ? TESTNET_PREFIX : MAINNET_PREFIX;

    // Construct ISM manager address (same logic as AleoBase)
    const ismManagerSuffix = process.env['ALEO_ISM_MANAGER_SUFFIX'];
    const ismManagerAddress = ismManagerSuffix
      ? `${prefix}_ism_manager_${ismManagerSuffix}.aleo`
      : `${prefix}_ism_manager.aleo`;

    this.onChainArtifactManagers = {
      ismManagerAddress,
      hookManagerAddress: '', // Ignored - derived from mailbox address in getMailboxConfig
    };
  }

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
      mailbox: () =>
        new AleoMailboxReader(this.aleoClient, this.onChainArtifactManagers),
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
        new AleoMailboxWriter(
          this.aleoClient,
          signer,
          this.domainId,
          this.onChainArtifactManagers,
        ),
    };

    const maybeWriter = writers[type]();

    assert(maybeWriter, `Mailbox writer for ${type} not found`);
    return maybeWriter;
  }
}
