import { QueryClient } from '@cosmjs/stargate';
import { connectComet } from '@cosmjs/tendermint-rpc';

import { AltVM } from '@hyperlane-xyz/provider-sdk';
import {
  type ArtifactReader,
  type ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  type DeployedWarpAddress,
  type DeployedWarpArtifact,
  type IRawWarpArtifactManager,
  type RawWarpArtifactConfigs,
  type WarpType,
} from '@hyperlane-xyz/provider-sdk/warp';

import { type CosmosNativeSigner } from '../clients/signer.js';
import { setupWarpExtension } from '../hyperlane/warp/query.js';

import {
  CosmosCollateralTokenReader,
  CosmosCollateralTokenWriter,
} from './collateral-token.js';
import {
  CosmosSyntheticTokenReader,
  CosmosSyntheticTokenWriter,
} from './synthetic-token.js';
import { type CosmosWarpQueryClient, getWarpTokenType } from './warp-query.js';

/**
 * Cosmos Warp Artifact Manager implementing IRawWarpArtifactManager.
 *
 * This manager:
 * - Lazily initializes the query client on first use
 * - Detects warp token types and delegates to specialized readers
 * - Provides factory methods for creating readers and writers
 *
 * Design: Uses lazy initialization to keep the constructor synchronous while
 * deferring the async query client creation until actually needed.
 */
export class CosmosWarpArtifactManager implements IRawWarpArtifactManager {
  private queryPromise?: Promise<CosmosWarpQueryClient>;

  constructor(private readonly rpcUrls: string[]) {}

  /**
   * Lazy initialization - creates query client on first use.
   * Subsequent calls return the cached promise.
   */
  private async getQuery(): Promise<CosmosWarpQueryClient> {
    if (!this.queryPromise) {
      this.queryPromise = this.createQuery();
    }
    return this.queryPromise;
  }

  /**
   * Creates a Cosmos query client with Warp extension.
   */
  private async createQuery(): Promise<CosmosWarpQueryClient> {
    const cometClient = await connectComet(this.rpcUrls[0]);
    return QueryClient.withExtensions(cometClient, setupWarpExtension);
  }

  /**
   * Read a warp token of unknown type from the blockchain.
   *
   * @param address - Address of the token to read
   * @returns Deployed warp token artifact with configuration
   */
  async readWarpToken(address: string): Promise<DeployedWarpArtifact> {
    const query = await this.getQuery();
    const altVMType = await getWarpTokenType(query, address);

    // Convert AltVM.TokenType to WarpType
    let warpType: WarpType;
    switch (altVMType) {
      case AltVM.TokenType.collateral:
        warpType = 'collateral';
        break;
      case AltVM.TokenType.synthetic:
        warpType = 'synthetic';
        break;
      default:
        throw new Error(
          `Token type ${altVMType} is not supported on Cosmos. Only collateral and synthetic tokens are supported.`,
        );
    }

    const reader = this.createReaderWithQuery(warpType, query);
    return reader.read(address);
  }

  /**
   * Factory method to create type-specific warp token readers.
   *
   * @param type - Warp token type to create reader for
   * @returns Type-specific warp token reader
   */
  createReader<T extends WarpType>(
    type: T,
  ): ArtifactReader<RawWarpArtifactConfigs[T], DeployedWarpAddress> {
    // For synchronous createReader, we return a wrapper that will initialize lazily
    return {
      read: async (address: string) => {
        const query = await this.getQuery();
        const reader = this.createReaderWithQuery(type, query);
        return reader.read(address);
      },
    } satisfies ArtifactReader<RawWarpArtifactConfigs[T], DeployedWarpAddress>;
  }

  /**
   * Internal helper to create type-specific warp token readers with query client.
   *
   * @param type - Warp token type to create reader for
   * @param query - Query client to use for reading
   * @returns Type-specific warp token reader
   */
  private createReaderWithQuery<T extends WarpType>(
    type: T,
    query: CosmosWarpQueryClient,
  ): ArtifactReader<RawWarpArtifactConfigs[T], DeployedWarpAddress> {
    const readers: {
      [K in WarpType]: () => ArtifactReader<
        RawWarpArtifactConfigs[K],
        DeployedWarpAddress
      >;
    } = {
      collateral: () => new CosmosCollateralTokenReader(query),
      synthetic: () => new CosmosSyntheticTokenReader(query),
      native: () => {
        throw new Error('Native tokens are not supported on Cosmos');
      },
    };

    return readers[type]();
  }

  /**
   * Factory method to create type-specific warp token writers.
   *
   * @param type - Warp token type to create writer for
   * @param signer - Signer to use for writing transactions
   * @returns Type-specific warp token writer
   */
  createWriter<T extends WarpType>(
    type: T,
    signer: CosmosNativeSigner,
  ): ArtifactWriter<RawWarpArtifactConfigs[T], DeployedWarpAddress> {
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
    } satisfies ArtifactWriter<RawWarpArtifactConfigs[T], DeployedWarpAddress>;
  }

  /**
   * Internal helper to create type-specific warp token writers with query client and signer.
   *
   * @param type - Warp token type to create writer for
   * @param query - Query client to use for reading
   * @param signer - Signer to use for writing
   * @returns Type-specific warp token writer
   */
  private createWriterWithQuery<T extends WarpType>(
    type: T,
    query: CosmosWarpQueryClient,
    signer: CosmosNativeSigner,
  ): ArtifactWriter<RawWarpArtifactConfigs[T], DeployedWarpAddress> {
    const writers: {
      [K in WarpType]: () => ArtifactWriter<
        RawWarpArtifactConfigs[K],
        DeployedWarpAddress
      >;
    } = {
      collateral: () => new CosmosCollateralTokenWriter(query, signer),
      synthetic: () => new CosmosSyntheticTokenWriter(query, signer),
      native: () => {
        throw new Error('Native tokens are not supported on Cosmos');
      },
    };

    return writers[type]();
  }
}
