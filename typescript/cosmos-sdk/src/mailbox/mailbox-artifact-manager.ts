import { QueryClient } from '@cosmjs/stargate';
import { connectComet } from '@cosmjs/tendermint-rpc';

import {
  ArtifactComposition,
  type ArtifactReader,
  type ArtifactWriter,
  type OrchestratedArtifactReader,
  type OrchestratedArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  type DeployedMailboxAddress,
  type DeployedRawMailboxArtifact,
  type IRawMailboxArtifactManager,
  type MailboxType,
  type MailboxArtifactConfigs,
} from '@hyperlane-xyz/provider-sdk/mailbox';
import { LazyAsync } from '@hyperlane-xyz/utils';

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
export class CosmosMailboxArtifactManager implements IRawMailboxArtifactManager {
  private readonly query = new LazyAsync(() => this.createQuery());

  constructor(
    private readonly config: {
      rpcUrls: [string, ...string[]];
      domainId: number;
    },
  ) {}

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
    const query = await this.query.get();
    const reader = new CosmosMailboxReader(query);
    return reader.read(address);
  }

  /**
   * Factory method to create mailbox readers.
   *
   * @param type - Mailbox type (currently only 'mailbox')
   * @returns Mailbox reader
   */
  createReader<T extends MailboxType>(
    type: T,
  ): ArtifactReader<MailboxArtifactConfigs[T], DeployedMailboxAddress> {
    const wrapper: OrchestratedArtifactReader<
      MailboxArtifactConfigs[T],
      DeployedMailboxAddress
    > = {
      composition: ArtifactComposition.ORCHESTRATED,
      read: async (address) => {
        const query = await this.query.get();
        const reader = this.createReaderWithQuery(type, query);
        return reader.read(address);
      },
    };
    return wrapper;
  }

  private createReaderWithQuery<T extends MailboxType>(
    type: T,
    query: CosmosMailboxQueryClient,
  ): OrchestratedArtifactReader<
    MailboxArtifactConfigs[T],
    DeployedMailboxAddress
  > {
    const readers: {
      [K in MailboxType]: () => OrchestratedArtifactReader<
        MailboxArtifactConfigs[K],
        DeployedMailboxAddress
      >;
    } = {
      mailbox: () => new CosmosMailboxReader(query),
    };

    return readers[type]();
  }

  /**
   * Factory method to create mailbox writers.
   *
   * @param type - Mailbox type (currently only 'mailbox')
   * @param signer - Signer to use for writing transactions
   * @returns Mailbox writer
   */
  createWriter<T extends MailboxType>(
    type: T,
    signer: CosmosNativeSigner,
  ): ArtifactWriter<MailboxArtifactConfigs[T], DeployedMailboxAddress> {
    const wrapper: OrchestratedArtifactWriter<
      MailboxArtifactConfigs[T],
      DeployedMailboxAddress
    > = {
      composition: ArtifactComposition.ORCHESTRATED,
      read: async (address) => {
        const query = await this.query.get();
        const writer = this.createWriterWithQuery(type, query, signer);
        return writer.read(address);
      },
      create: async (artifact) => {
        const query = await this.query.get();
        const writer = this.createWriterWithQuery(type, query, signer);
        return writer.create(artifact);
      },
      update: async (artifact) => {
        const query = await this.query.get();
        const writer = this.createWriterWithQuery(type, query, signer);
        return writer.update(artifact);
      },
    };
    return wrapper;
  }

  private createWriterWithQuery<T extends MailboxType>(
    type: T,
    query: CosmosMailboxQueryClient,
    signer: CosmosNativeSigner,
  ): OrchestratedArtifactWriter<
    MailboxArtifactConfigs[T],
    DeployedMailboxAddress
  > {
    const writers: {
      [K in MailboxType]: () => OrchestratedArtifactWriter<
        MailboxArtifactConfigs[K],
        DeployedMailboxAddress
      >;
    } = {
      mailbox: () =>
        new CosmosMailboxWriter(query, signer, this.config.domainId),
    };

    return writers[type]();
  }
}
