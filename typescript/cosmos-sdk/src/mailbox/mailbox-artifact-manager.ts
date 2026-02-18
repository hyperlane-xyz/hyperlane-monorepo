import { QueryClient } from '@cosmjs/stargate';
import { connectComet } from '@cosmjs/tendermint-rpc';

import {
  type ArtifactReader,
  type ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  type DeployedMailboxAddress,
  type DeployedRawMailboxArtifact,
  type IRawMailboxArtifactManager,
  type MailboxType,
  type RawMailboxArtifactConfigs,
} from '@hyperlane-xyz/provider-sdk/mailbox';

import { type CosmosNativeSigner } from '../clients/signer.js';
import { setupCoreExtension } from '../hyperlane/core/query.js';

import { type CosmosMailboxQueryClient } from './mailbox-query.js';
import { CosmosMailboxReader, CosmosMailboxWriter } from './mailbox.js';

/**
 * Cosmos Mailbox Artifact Manager implementing IRawMailboxArtifactManager.
 *
 * This manager:
 * - Lazily initializes the query client on first use
 * - Provides factory methods for creating readers and writers
 *
 * Design: Uses lazy initialization to keep the constructor synchronous while
 * deferring the async query client creation until actually needed.
 */
export class CosmosMailboxArtifactManager
  implements IRawMailboxArtifactManager
{
  private queryPromise?: Promise<CosmosMailboxQueryClient>;

  constructor(
    private readonly config: {
      rpcUrls: [string, ...string[]];
      domainId: number;
    },
  ) {}

  /**
   * Lazy initialization - creates query client on first use.
   * Subsequent calls return the cached promise.
   */
  private async getQuery(): Promise<CosmosMailboxQueryClient> {
    if (!this.queryPromise) {
      this.queryPromise = this.createQuery();
    }
    return this.queryPromise;
  }

  /**
   * Creates a Cosmos query client with Core extension.
   */
  private async createQuery(): Promise<CosmosMailboxQueryClient> {
    const cometClient = await connectComet(this.config.rpcUrls[0]);
    return QueryClient.withExtensions(cometClient, setupCoreExtension);
  }

  /**
   * Read a mailbox from the blockchain.
   *
   * @param address - Address of the mailbox to read
   * @returns Deployed mailbox artifact with configuration
   */
  async readMailbox(address: string): Promise<DeployedRawMailboxArtifact> {
    const query = await this.getQuery();
    const reader = new CosmosMailboxReader(query);
    return reader.read(address);
  }

  /**
   * Factory method to create mailbox readers.
   *
   * @param _type - Mailbox type (currently only 'mailbox')
   * @returns Mailbox reader
   */
  createReader<T extends MailboxType>(
    _type: T,
  ): ArtifactReader<RawMailboxArtifactConfigs[T], DeployedMailboxAddress> {
    return {
      read: async (address: string) => {
        const query = await this.getQuery();
        const reader = new CosmosMailboxReader(query);
        return reader.read(address);
      },
    } satisfies ArtifactReader<
      RawMailboxArtifactConfigs[T],
      DeployedMailboxAddress
    >;
  }

  /**
   * Factory method to create mailbox writers.
   *
   * @param _type - Mailbox type (currently only 'mailbox')
   * @param signer - Signer to use for writing transactions
   * @returns Mailbox writer
   */
  createWriter<T extends MailboxType>(
    _type: T,
    signer: CosmosNativeSigner,
  ): ArtifactWriter<RawMailboxArtifactConfigs[T], DeployedMailboxAddress> {
    return {
      read: async (address: string) => {
        const query = await this.getQuery();
        const writer = new CosmosMailboxWriter(
          query,
          signer,
          this.config.domainId,
        );
        return writer.read(address);
      },
      create: async (artifact) => {
        const query = await this.getQuery();
        const writer = new CosmosMailboxWriter(
          query,
          signer,
          this.config.domainId,
        );
        return writer.create(artifact);
      },
      update: async (artifact) => {
        const query = await this.getQuery();
        const writer = new CosmosMailboxWriter(
          query,
          signer,
          this.config.domainId,
        );
        return writer.update(artifact);
      },
    } satisfies ArtifactWriter<
      RawMailboxArtifactConfigs[T],
      DeployedMailboxAddress
    >;
  }
}
