import { QueryClient } from '@cosmjs/stargate';
import { connectComet } from '@cosmjs/tendermint-rpc';

import { AltVM, ProtocolType } from '@hyperlane-xyz/provider-sdk';
import {
  type ArtifactReader,
  type ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  type DeployedRawWarpArtifact,
  type DeployedWarpAddress,
  type IRawWarpArtifactManager,
  type RawWarpArtifactConfigs,
  type WarpArtifactReaderFactories,
  type WarpArtifactWriterFactories,
  type WarpType,
  throwUnsupportedWarpType,
} from '@hyperlane-xyz/provider-sdk/warp';
import { LazyAsync, assert } from '@hyperlane-xyz/utils';

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
  private readonly query = new LazyAsync(() => this.createQuery());
  private readonly rpcUrl: string;

  constructor(rpcUrls: string[]) {
    const [rpcUrl] = rpcUrls;
    assert(rpcUrl, `${CosmosWarpArtifactManager.name} got no rpcUrls`);
    this.rpcUrl = rpcUrl;
  }

  private async getQuery(): Promise<CosmosWarpQueryClient> {
    return this.query.get();
  }

  private async createQuery(): Promise<CosmosWarpQueryClient> {
    const cometClient = await connectComet(this.rpcUrl);
    return QueryClient.withExtensions(cometClient, setupWarpExtension);
  }

  supportsHookUpdates(): boolean {
    return false;
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
        return throwUnsupportedWarpType(altVMType, ProtocolType.CosmosNative);
    }

    const reader = this.createReader(warpType);
    return reader.read(address);
  }

  createReader<T extends WarpType>(
    type: T,
  ): ArtifactReader<RawWarpArtifactConfigs[T], DeployedWarpAddress> {
    const readers: WarpArtifactReaderFactories = {
      collateral: () =>
        this.createLazyReader(
          (query) => new CosmosCollateralTokenReader(query),
        ),
      synthetic: () =>
        this.createLazyReader((query) => new CosmosSyntheticTokenReader(query)),
    };

    const reader = readers[type];
    if (!reader) {
      return throwUnsupportedWarpType(type, ProtocolType.CosmosNative);
    }

    return reader();
  }

  private createLazyReader<C>(
    createReader: (
      query: CosmosWarpQueryClient,
    ) => ArtifactReader<C, DeployedWarpAddress>,
  ): ArtifactReader<C, DeployedWarpAddress> {
    return {
      read: async (address: string) => {
        const query = await this.getQuery();
        return createReader(query).read(address);
      },
    };
  }

  createWriter<T extends WarpType>(
    type: T,
    signer: CosmosNativeSigner,
  ): ArtifactWriter<RawWarpArtifactConfigs[T], DeployedWarpAddress> {
    const writers: WarpArtifactWriterFactories = {
      collateral: () =>
        this.createLazyWriter(
          (query) => new CosmosCollateralTokenWriter(query, signer),
        ),
      synthetic: () =>
        this.createLazyWriter(
          (query) => new CosmosSyntheticTokenWriter(query, signer),
        ),
    };

    const writer = writers[type];
    if (!writer) {
      return throwUnsupportedWarpType(type, ProtocolType.CosmosNative);
    }

    return writer();
  }

  private createLazyWriter<C>(
    createWriter: (
      query: CosmosWarpQueryClient,
    ) => ArtifactWriter<C, DeployedWarpAddress>,
  ): ArtifactWriter<C, DeployedWarpAddress> {
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
