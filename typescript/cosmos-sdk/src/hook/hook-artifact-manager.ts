import { QueryClient } from '@cosmjs/stargate';
import { connectComet } from '@cosmjs/tendermint-rpc';

import { AltVM } from '@hyperlane-xyz/provider-sdk';
import {
  type ArtifactReader,
  type ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  type DeployedHookAddress,
  type DeployedHookArtifact,
  type HookConfigs,
  type HookType,
  type IRawHookArtifactManager,
  type RawHookArtifactConfigs,
} from '@hyperlane-xyz/provider-sdk/hook';
import { assert } from '@hyperlane-xyz/utils';

import { type CosmosNativeSigner } from '../clients/signer.js';
import { setupPostDispatchExtension } from '../hyperlane/post_dispatch/query.js';

import { type CosmosHookQueryClient, getHookType } from './hook-query.js';
import { CosmosIgpHookReader, CosmosIgpHookWriter } from './igp-hook.js';
import {
  CosmosMerkleTreeHookReader,
  CosmosMerkleTreeHookWriter,
} from './merkle-tree-hook.js';

/**
 * Cosmos Hook Artifact Manager implementing IRawHookArtifactManager.
 *
 * This manager:
 * - Lazily initializes the query client on first use
 * - Provides factory methods for creating readers and writers
 * - Supports IGP and MerkleTree hook types
 *
 * Design: Uses lazy initialization to keep the constructor synchronous while
 * deferring the async query client creation until actually needed.
 */
export class CosmosHookArtifactManager implements IRawHookArtifactManager {
  private queryPromise?: Promise<CosmosHookQueryClient>;

  constructor(
    private readonly rpcUrls: string[],
    private readonly mailboxAddress: string,
    private readonly nativeTokenDenom: string,
  ) {
    assert(rpcUrls.length > 0, 'rpcUrls must not be empty');
  }

  /**
   * Lazy initialization - creates query client on first use.
   * Subsequent calls return the cached promise.
   */
  private async getQuery(): Promise<CosmosHookQueryClient> {
    if (!this.queryPromise) {
      this.queryPromise = this.createQuery();
    }
    return this.queryPromise;
  }

  /**
   * Creates a Cosmos query client with PostDispatch extension.
   */
  private async createQuery(): Promise<CosmosHookQueryClient> {
    const cometClient = await connectComet(this.rpcUrls[0]);
    return QueryClient.withExtensions(cometClient, setupPostDispatchExtension);
  }

  /**
   * Read a hook of unknown type from the blockchain.
   *
   * @param address - Address of the hook to read
   * @returns Deployed hook artifact with configuration
   */
  async readHook(address: string): Promise<DeployedHookArtifact> {
    const query = await this.getQuery();
    const altVMType = await getHookType(query, address);

    const reader = this.createReaderWithQuery(
      altVMType as keyof HookConfigs,
      query,
    );
    return reader.read(address);
  }

  /**
   * Factory method to create type-specific hook readers.
   *
   * @param type - Hook type to create reader for
   * @returns Type-specific hook reader
   */
  createReader<T extends HookType>(
    type: T,
  ): ArtifactReader<RawHookArtifactConfigs[T], DeployedHookAddress> {
    // For synchronous createReader, we return a wrapper that will initialize lazily
    return {
      read: async (address: string) => {
        const query = await this.getQuery();
        const reader = this.createReaderWithQuery(type, query);
        return reader.read(address);
      },
    } as ArtifactReader<RawHookArtifactConfigs[T], DeployedHookAddress>;
  }

  /**
   * Internal helper to create type-specific hook readers with query client.
   *
   * @param type - Hook type to create reader for
   * @param query - Query client to use for reading
   * @returns Type-specific hook reader
   */
  private createReaderWithQuery<T extends HookType>(
    type: T,
    query: CosmosHookQueryClient,
  ): ArtifactReader<RawHookArtifactConfigs[T], DeployedHookAddress> {
    switch (type) {
      case AltVM.HookType.MERKLE_TREE:
        return new CosmosMerkleTreeHookReader(
          query,
        ) as unknown as ArtifactReader<
          RawHookArtifactConfigs[T],
          DeployedHookAddress
        >;
      case AltVM.HookType.INTERCHAIN_GAS_PAYMASTER:
        return new CosmosIgpHookReader(query) as unknown as ArtifactReader<
          RawHookArtifactConfigs[T],
          DeployedHookAddress
        >;
      default:
        throw new Error(`Unsupported Hook type: ${type}`);
    }
  }

  /**
   * Factory method to create type-specific hook writers.
   *
   * @param type - Hook type to create writer for
   * @param signer - Signer to use for writing transactions
   * @returns Type-specific hook writer
   */
  createWriter<T extends HookType>(
    type: T,
    signer: CosmosNativeSigner,
  ): ArtifactWriter<RawHookArtifactConfigs[T], DeployedHookAddress> {
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
    } as ArtifactWriter<RawHookArtifactConfigs[T], DeployedHookAddress>;
  }

  /**
   * Internal helper to create type-specific hook writers with query client and signer.
   *
   * @param type - Hook type to create writer for
   * @param query - Query client to use for reading
   * @param signer - Signer to use for writing
   * @returns Type-specific hook writer
   */
  private createWriterWithQuery<T extends HookType>(
    type: T,
    query: CosmosHookQueryClient,
    signer: CosmosNativeSigner,
  ): ArtifactWriter<RawHookArtifactConfigs[T], DeployedHookAddress> {
    switch (type) {
      case AltVM.HookType.MERKLE_TREE:
        return new CosmosMerkleTreeHookWriter(
          query,
          signer,
          this.mailboxAddress,
        ) as unknown as ArtifactWriter<
          RawHookArtifactConfigs[T],
          DeployedHookAddress
        >;
      case AltVM.HookType.INTERCHAIN_GAS_PAYMASTER:
        return new CosmosIgpHookWriter(
          query,
          signer,
          this.nativeTokenDenom,
        ) as unknown as ArtifactWriter<
          RawHookArtifactConfigs[T],
          DeployedHookAddress
        >;
      default:
        throw new Error(`Unsupported Hook type: ${type}`);
    }
  }
}
