import { QueryClient } from '@cosmjs/stargate';
import { connectComet } from '@cosmjs/tendermint-rpc';

import { AltVM, ProtocolType } from '@hyperlane-xyz/provider-sdk';
import {
  type ArtifactReader,
  type ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  type DeployedIsmAddress,
  type DeployedRawIsmArtifact,
  type IRawIsmArtifactManager,
  type IsmArtifactReaderFactories,
  type IsmArtifactWriterFactories,
  type IsmType,
  type RawIsmArtifactConfigs,
  altVMIsmTypeToProviderSdkType,
  throwUnsupportedIsmType,
} from '@hyperlane-xyz/provider-sdk/ism';
import { LazyAsync, assert } from '@hyperlane-xyz/utils';

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
  private readonly query = new LazyAsync(() => this.createQuery());
  private readonly rpcUrl: string;

  constructor(rpcUrls: string[]) {
    const [rpcUrl] = rpcUrls;
    assert(rpcUrl, `${CosmosIsmArtifactManager.name} got no rpcUrls`);
    this.rpcUrl = rpcUrl;
  }

  /**
   * Lazy initialization - creates query client on first use.
   * Subsequent calls return the cached promise.
   */
  private getQuery(): Promise<CosmosIsmQueryClient> {
    return this.query.get();
  }

  /**
   * Creates a Cosmos query client with ISM extension.
   */
  private async createQuery(): Promise<CosmosIsmQueryClient> {
    const cometClient = await connectComet(this.rpcUrl);
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
    const reader = this.createReader(altVMIsmTypeToProviderSdkType(altVMType));
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
    const readers: IsmArtifactReaderFactories = {
      [AltVM.IsmType.TEST_ISM]: () =>
        this.createLazyReader((query) => new CosmosTestIsmReader(query)),
      [AltVM.IsmType.MERKLE_ROOT_MULTISIG]: () =>
        this.createLazyReader(
          (query) => new CosmosMerkleRootMultisigIsmReader(query),
        ),
      [AltVM.IsmType.MESSAGE_ID_MULTISIG]: () =>
        this.createLazyReader(
          (query) => new CosmosMessageIdMultisigIsmReader(query),
        ),
      [AltVM.IsmType.ROUTING]: () =>
        this.createLazyReader((query) => new CosmosRoutingIsmRawReader(query)),
    };

    const reader = readers[type];
    if (!reader) {
      return throwUnsupportedIsmType(type, ProtocolType.CosmosNative);
    }

    return reader();
  }

  private createLazyReader<C>(
    createReader: (
      query: CosmosIsmQueryClient,
    ) => ArtifactReader<C, DeployedIsmAddress>,
  ): ArtifactReader<C, DeployedIsmAddress> {
    return {
      read: async (address: string) => {
        const query = await this.getQuery();
        return createReader(query).read(address);
      },
    };
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
    const writers: IsmArtifactWriterFactories = {
      [AltVM.IsmType.TEST_ISM]: () =>
        this.createLazyWriter(
          (query) => new CosmosTestIsmWriter(query, signer),
        ),
      [AltVM.IsmType.MERKLE_ROOT_MULTISIG]: () =>
        this.createLazyWriter(
          (query) => new CosmosMerkleRootMultisigIsmWriter(query, signer),
        ),
      [AltVM.IsmType.MESSAGE_ID_MULTISIG]: () =>
        this.createLazyWriter(
          (query) => new CosmosMessageIdMultisigIsmWriter(query, signer),
        ),
      [AltVM.IsmType.ROUTING]: () =>
        this.createLazyWriter(
          (query) => new CosmosRoutingIsmRawWriter(query, signer),
        ),
    };

    const writer = writers[type];
    if (!writer) {
      return throwUnsupportedIsmType(type, ProtocolType.CosmosNative);
    }

    return writer();
  }

  private createLazyWriter<C>(
    createWriter: (
      query: CosmosIsmQueryClient,
    ) => ArtifactWriter<C, DeployedIsmAddress>,
  ): ArtifactWriter<C, DeployedIsmAddress> {
    return {
      read: async (address: string) => {
        const query = await this.getQuery();
        return createWriter(query).read(address);
      },
      create: async (artifact) => {
        const query = await this.getQuery();
        return createWriter(query).create(artifact);
      },
      update: async (artifact) => {
        const query = await this.getQuery();
        return createWriter(query).update(artifact);
      },
    };
  }
}
