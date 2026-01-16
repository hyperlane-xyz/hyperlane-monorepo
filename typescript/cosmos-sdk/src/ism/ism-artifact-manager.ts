import { QueryClient } from '@cosmjs/stargate';
import { connectComet } from '@cosmjs/tendermint-rpc';

import { AltVM } from '@hyperlane-xyz/provider-sdk';
import {
  type ArtifactReader,
  type ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  type DeployedIsmAddress,
  type DeployedRawIsmArtifact,
  type IRawIsmArtifactManager,
  type IsmType,
  type RawIsmArtifactConfigs,
} from '@hyperlane-xyz/provider-sdk/ism';

import { type CosmosNativeSigner } from '../clients/signer.js';
import { setupInterchainSecurityExtension } from '../hyperlane/interchain_security/query.js';

import { type CosmosIsmQueryClient, getIsmType } from './ism-query.js';
import {
  CosmosMerkleRootMultisigIsmReader,
  CosmosMerkleRootMultisigIsmWriter,
  CosmosMessageIdMultisigIsmReader,
  CosmosMessageIdMultisigIsmWriter,
} from './multisig-ism.js';
import {
  CosmosRoutingIsmRawReader,
  CosmosRoutingIsmRawWriter,
} from './routing-ism.js';
import { CosmosTestIsmReader, CosmosTestIsmWriter } from './test-ism.js';

/**
 * Cosmos ISM Artifact Manager implementing IRawIsmArtifactManager.
 *
 * This manager:
 * - Lazily initializes the query client on first use
 * - Detects ISM types and delegates to specialized readers
 * - Provides factory methods for creating readers and writers
 *
 * Design: Uses lazy initialization to keep the constructor synchronous while
 * deferring the async query client creation until actually needed.
 */
export class CosmosIsmArtifactManager implements IRawIsmArtifactManager {
  private queryPromise?: Promise<CosmosIsmQueryClient>;

  constructor(private readonly rpcUrls: string[]) {}

  /**
   * Lazy initialization - creates query client on first use.
   * Subsequent calls return the cached promise.
   */
  private async getQuery(): Promise<CosmosIsmQueryClient> {
    if (!this.queryPromise) {
      this.queryPromise = this.createQuery();
    }
    return this.queryPromise;
  }

  /**
   * Creates a Cosmos query client with ISM extension.
   */
  private async createQuery(): Promise<CosmosIsmQueryClient> {
    const cometClient = await connectComet(this.rpcUrls[0]);
    return QueryClient.withExtensions(
      cometClient,
      setupInterchainSecurityExtension,
    );
  }

  /**
   * Read an ISM of unknown type from the blockchain.
   *
   * @param address - Address of the ISM to read
   * @returns Deployed ISM artifact with configuration
   */
  async readIsm(address: string): Promise<DeployedRawIsmArtifact> {
    const query = await this.getQuery();
    const altVMType = await getIsmType(query, address);
    // Type assertion needed because getIsmType returns IsmType (union),
    // but createReaderWithQuery expects a specific type T extends IsmType.
    // The reader will return the correct artifact type at runtime.
    const reader = this.createReaderWithQuery(
      altVMType as keyof RawIsmArtifactConfigs,
      query,
    );
    return reader.read(address);
  }

  /**
   * Factory method to create type-specific ISM readers (public interface).
   * Note: This method doesn't have access to query client yet, so it must be async.
   *
   * @param type - ISM type to create reader for
   * @returns Type-specific ISM reader
   */
  createReader<T extends IsmType>(
    type: T,
  ): ArtifactReader<RawIsmArtifactConfigs[T], DeployedIsmAddress> {
    // For synchronous createReader, we return a wrapper that will initialize lazily
    return {
      read: async (address: string) => {
        const query = await this.getQuery();
        const reader = this.createReaderWithQuery(type, query);
        return reader.read(address);
      },
    } as ArtifactReader<RawIsmArtifactConfigs[T], DeployedIsmAddress>;
  }

  /**
   * Internal helper to create type-specific ISM readers with query client.
   *
   * @param type - ISM type to create reader for
   * @param query - Query client to use for reading
   * @returns Type-specific ISM reader
   */
  private createReaderWithQuery<T extends IsmType>(
    type: T,
    query: CosmosIsmQueryClient,
  ): ArtifactReader<RawIsmArtifactConfigs[T], DeployedIsmAddress> {
    switch (type) {
      case AltVM.IsmType.TEST_ISM:
        return new CosmosTestIsmReader(query) as unknown as ArtifactReader<
          RawIsmArtifactConfigs[T],
          DeployedIsmAddress
        >;
      case AltVM.IsmType.MERKLE_ROOT_MULTISIG:
        return new CosmosMerkleRootMultisigIsmReader(
          query,
        ) as unknown as ArtifactReader<
          RawIsmArtifactConfigs[T],
          DeployedIsmAddress
        >;
      case AltVM.IsmType.MESSAGE_ID_MULTISIG:
        return new CosmosMessageIdMultisigIsmReader(
          query,
        ) as unknown as ArtifactReader<
          RawIsmArtifactConfigs[T],
          DeployedIsmAddress
        >;
      case AltVM.IsmType.ROUTING:
        return new CosmosRoutingIsmRawReader(
          query,
        ) as unknown as ArtifactReader<
          RawIsmArtifactConfigs[T],
          DeployedIsmAddress
        >;
      default:
        throw new Error(`Unsupported ISM type: ${type}`);
    }
  }

  /**
   * Factory method to create type-specific ISM writers.
   *
   * @param type - ISM type to create writer for
   * @param signer - Signer to use for writing transactions
   * @returns Type-specific ISM writer
   */
  createWriter<T extends IsmType>(
    type: T,
    signer: CosmosNativeSigner,
  ): ArtifactWriter<RawIsmArtifactConfigs[T], DeployedIsmAddress> {
    // For synchronous createWriter, we return a wrapper that will initialize lazily
    return {
      read: async (address: string) => {
        const query = await this.getQuery();
        const writer = this.createWriterWithQuery(type, query, signer);
        return writer.read(address);
      },
      create: async (artifact) => {
        const query = await this.getQuery();
        const writer = this.createWriterWithQuery(type, query, signer);
        return writer.create(artifact);
      },
      update: async (artifact) => {
        const query = await this.getQuery();
        const writer = this.createWriterWithQuery(type, query, signer);
        return writer.update(artifact);
      },
    };
  }

  /**
   * Internal helper to create type-specific ISM writers with query client and signer.
   *
   * @param type - ISM type to create writer for
   * @param query - Query client to use for reading
   * @param signer - Signer to use for writing
   * @returns Type-specific ISM writer
   */
  private createWriterWithQuery<T extends IsmType>(
    type: T,
    query: CosmosIsmQueryClient,
    signer: CosmosNativeSigner,
  ): ArtifactWriter<RawIsmArtifactConfigs[T], DeployedIsmAddress> {
    switch (type) {
      case AltVM.IsmType.TEST_ISM:
        return new CosmosTestIsmWriter(
          query,
          signer,
        ) as unknown as ArtifactWriter<
          RawIsmArtifactConfigs[T],
          DeployedIsmAddress
        >;
      case AltVM.IsmType.MERKLE_ROOT_MULTISIG:
        return new CosmosMerkleRootMultisigIsmWriter(
          query,
          signer,
        ) as unknown as ArtifactWriter<
          RawIsmArtifactConfigs[T],
          DeployedIsmAddress
        >;
      case AltVM.IsmType.MESSAGE_ID_MULTISIG:
        return new CosmosMessageIdMultisigIsmWriter(
          query,
          signer,
        ) as unknown as ArtifactWriter<
          RawIsmArtifactConfigs[T],
          DeployedIsmAddress
        >;
      case AltVM.IsmType.ROUTING:
        return new CosmosRoutingIsmRawWriter(
          query,
          signer,
        ) as unknown as ArtifactWriter<
          RawIsmArtifactConfigs[T],
          DeployedIsmAddress
        >;
      default:
        throw new Error(`Unsupported ISM type: ${type}`);
    }
  }
}
