import { TronWeb } from 'tronweb';

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
import {
  type AnnotatedTx,
  type TxReceipt,
} from '@hyperlane-xyz/provider-sdk/module';
import { strip0x } from '@hyperlane-xyz/utils';

import { type TronIsmQueryClient, getIsmType } from './ism-query.js';
import {
  TronMerkleRootMultisigIsmReader,
  TronMessageIdMultisigIsmReader,
} from './multisig-ism.js';
import { TronRoutingIsmRawReader } from './routing-ism.js';
import { TronTestIsmReader } from './test-ism.js';

/**
 * Tron ISM Artifact Manager implementing IRawIsmArtifactManager.
 *
 * This manager:
 * - Lazily initializes the query client on first use
 * - Detects ISM types and delegates to specialized readers
 * - Provides factory methods for creating readers and writers
 *
 * Design: Uses lazy initialization to keep the constructor synchronous while
 * deferring the async query client creation until actually needed.
 */
export class TronIsmArtifactManager implements IRawIsmArtifactManager {
  private queryPromise?: Promise<TronIsmQueryClient>;

  constructor(private readonly rpcUrls: string[]) {}

  /**
   * Lazy initialization - creates query client on first use.
   * Subsequent calls return the cached promise.
   */
  private async getQuery(): Promise<TronIsmQueryClient> {
    if (!this.queryPromise) {
      this.queryPromise = this.createQuery();
    }
    return this.queryPromise;
  }

  /**
   * Creates a Tron query client with ISM extension.
   */
  private async createQuery(): Promise<TronIsmQueryClient> {
    const { privateKey } = new TronWeb({
      fullHost: this.rpcUrls[0],
    }).createRandom();

    return new TronWeb({
      fullHost: this.rpcUrls[0],
      privateKey: strip0x(privateKey),
    });
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
    query: TronIsmQueryClient,
  ): ArtifactReader<RawIsmArtifactConfigs[T], DeployedIsmAddress> {
    switch (type) {
      case AltVM.IsmType.TEST_ISM:
        return new TronTestIsmReader(query) as unknown as ArtifactReader<
          RawIsmArtifactConfigs[T],
          DeployedIsmAddress
        >;
      case AltVM.IsmType.MERKLE_ROOT_MULTISIG:
        return new TronMerkleRootMultisigIsmReader(
          query,
        ) as unknown as ArtifactReader<
          RawIsmArtifactConfigs[T],
          DeployedIsmAddress
        >;
      case AltVM.IsmType.MESSAGE_ID_MULTISIG:
        return new TronMessageIdMultisigIsmReader(
          query,
        ) as unknown as ArtifactReader<
          RawIsmArtifactConfigs[T],
          DeployedIsmAddress
        >;
      case AltVM.IsmType.ROUTING:
        return new TronRoutingIsmRawReader(query) as unknown as ArtifactReader<
          RawIsmArtifactConfigs[T],
          DeployedIsmAddress
        >;
      default:
        throw new Error(`Unsupported ISM type: ${type}`);
    }
  }

  /**
   * Factory method to create type-specific ISM writers.
   * Currently not implemented - will be added in future work.
   *
   * @param type - ISM type to create writer for
   * @param _signer - Signer to use for writing
   * @returns Type-specific ISM writer
   * @throws Error indicating writers are not yet implemented
   */
  createWriter<T extends IsmType>(
    type: T,
    _signer: AltVM.ISigner<AnnotatedTx, TxReceipt>,
  ): ArtifactWriter<RawIsmArtifactConfigs[T], DeployedIsmAddress> {
    throw new Error(
      `ISM writers not yet implemented for Tron (requested type: ${type})`,
    );
  }
}
