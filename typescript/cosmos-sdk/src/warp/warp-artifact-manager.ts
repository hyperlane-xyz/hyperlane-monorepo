import { QueryClient } from '@cosmjs/stargate';
import { connectComet } from '@cosmjs/tendermint-rpc';

import { AltVM } from '@hyperlane-xyz/provider-sdk';
import {
  type ArtifactReader,
  type ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  type DeployedRawWarpArtifact,
  type DeployedWarpAddress,
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

// Uses lazy initialization to keep constructor synchronous while deferring async query client creation
export class CosmosWarpArtifactManager implements IRawWarpArtifactManager {
  private queryPromise?: Promise<CosmosWarpQueryClient>;

  constructor(private readonly rpcUrls: string[]) {}

  private async getQuery(): Promise<CosmosWarpQueryClient> {
    if (!this.queryPromise) {
      this.queryPromise = this.createQuery();
    }
    return this.queryPromise;
  }

  private async createQuery(): Promise<CosmosWarpQueryClient> {
    const cometClient = await connectComet(this.rpcUrls[0]);
    return QueryClient.withExtensions(cometClient, setupWarpExtension);
  }

  async readWarpToken(address: string): Promise<DeployedRawWarpArtifact> {
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
