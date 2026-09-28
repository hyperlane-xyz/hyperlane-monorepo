import { QueryClient } from '@cosmjs/stargate';
import { connectComet } from '@cosmjs/tendermint-rpc';

import { AltVM, ProtocolType } from '@hyperlane-xyz/provider-sdk';
import {
  type ArtifactReader,
  type ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  type DeployedHookAddress,
  type DeployedHookArtifact,
  type HookArtifactReaderFactories,
  type HookArtifactWriterFactories,
  type HookType,
  type IRawHookArtifactManager,
  type RawHookArtifactConfigs,
  altVmHookTypeToProviderHookType,
  throwUnsupportedHookType,
} from '@hyperlane-xyz/provider-sdk/hook';
import { LazyAsync, assert } from '@hyperlane-xyz/utils';

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
  private readonly query = new LazyAsync(() => this.createQuery());

  constructor(
    private readonly config: {
      rpcUrls: [string, ...string[]];
      // Required only on deployments
      mailboxAddress?: string;
      nativeTokenDenom: string;
    },
  ) {}

  /**
   * Lazy initialization - creates query client on first use.
   * Subsequent calls return the cached promise.
   */
  private getQuery(): Promise<CosmosHookQueryClient> {
    return this.query.get();
  }

  /**
   * Creates a Cosmos query client with PostDispatch extension.
   */
  private async createQuery(): Promise<CosmosHookQueryClient> {
    const cometClient = await connectComet(this.config.rpcUrls[0]);
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
    const reader = this.createReader(
      altVmHookTypeToProviderHookType(altVMType),
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
    const readers: HookArtifactReaderFactories = {
      [AltVM.HookType.MERKLE_TREE]: () =>
        this.createLazyReader((query) => new CosmosMerkleTreeHookReader(query)),
      [AltVM.HookType.INTERCHAIN_GAS_PAYMASTER]: () =>
        this.createLazyReader((query) => new CosmosIgpHookReader(query)),
    };

    const reader = readers[type];
    if (!reader) {
      return throwUnsupportedHookType(type, ProtocolType.CosmosNative);
    }

    return reader();
  }

  private createLazyReader<C>(
    createReader: (
      query: CosmosHookQueryClient,
    ) => ArtifactReader<C, DeployedHookAddress>,
  ): ArtifactReader<C, DeployedHookAddress> {
    return {
      read: async (address: string) => {
        const query = await this.getQuery();
        return createReader(query).read(address);
      },
    };
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
    const writers: HookArtifactWriterFactories = {
      [AltVM.HookType.MERKLE_TREE]: () =>
        this.createLazyWriter((query) => {
          assert(
            this.config.mailboxAddress,
            `Mailbox needs to be defined to deploy a ${AltVM.HookType.MERKLE_TREE} hook`,
          );
          return new CosmosMerkleTreeHookWriter(
            query,
            signer,
            this.config.mailboxAddress,
          );
        }),
      [AltVM.HookType.INTERCHAIN_GAS_PAYMASTER]: () =>
        this.createLazyWriter(
          (query) =>
            new CosmosIgpHookWriter(
              query,
              signer,
              this.config.nativeTokenDenom,
            ),
        ),
    };

    const writer = writers[type];
    if (!writer) {
      return throwUnsupportedHookType(type, ProtocolType.CosmosNative);
    }

    return writer();
  }

  private createLazyWriter<C>(
    createWriter: (
      query: CosmosHookQueryClient,
    ) => ArtifactWriter<C, DeployedHookAddress>,
  ): ArtifactWriter<C, DeployedHookAddress> {
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
