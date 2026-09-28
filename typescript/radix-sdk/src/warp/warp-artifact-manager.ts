import { GatewayApiClient } from '@radixdlt/babylon-gateway-api-sdk';

import { ProtocolType } from '@hyperlane-xyz/provider-sdk';
import {
  ArtifactReader,
  ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  DeployedRawWarpArtifact,
  DeployedWarpAddress,
  IRawWarpArtifactManager,
  RawWarpArtifactConfigs,
  WarpArtifactReaderFactories,
  WarpArtifactWriterFactories,
  WarpType,
  throwUnsupportedWarpType,
} from '@hyperlane-xyz/provider-sdk/warp';

import { RadixSigner } from '../clients/signer.js';
import { RadixBase } from '../utils/base.js';

import {
  RadixCollateralTokenReader,
  RadixCollateralTokenWriter,
} from './collateral-token.js';
import {
  RadixSyntheticTokenReader,
  RadixSyntheticTokenWriter,
} from './synthetic-token.js';
import {
  getRadixWarpTokenType,
  providerWarpTokenTypeFromRadixTokenType,
} from './warp-query.js';

export class RadixWarpArtifactManager implements IRawWarpArtifactManager {
  constructor(
    private readonly gateway: GatewayApiClient,
    private readonly base: RadixBase,
  ) {}

  supportsHookUpdates(): boolean {
    return false;
  }

  async readWarpToken(address: string): Promise<DeployedRawWarpArtifact> {
    // Detect warp token type first
    const warpType = await getRadixWarpTokenType(this.gateway, address);

    // Get the appropriate reader and read the token
    const reader = this.createReader(
      providerWarpTokenTypeFromRadixTokenType(warpType),
    );
    return reader.read(address);
  }

  createReader<T extends WarpType>(
    type: T,
  ): ArtifactReader<RawWarpArtifactConfigs[T], DeployedWarpAddress> {
    const readers: WarpArtifactReaderFactories = {
      collateral: () => new RadixCollateralTokenReader(this.gateway, this.base),
      synthetic: () => new RadixSyntheticTokenReader(this.gateway, this.base),
    };

    const reader = readers[type];
    if (!reader) {
      return throwUnsupportedWarpType(type, ProtocolType.Radix);
    }

    return reader();
  }

  createWriter<T extends WarpType>(
    type: T,
    signer: RadixSigner,
  ): ArtifactWriter<RawWarpArtifactConfigs[T], DeployedWarpAddress> {
    const baseSigner = signer.getBaseSigner();

    const writers: WarpArtifactWriterFactories = {
      collateral: () =>
        new RadixCollateralTokenWriter(this.gateway, baseSigner, this.base),
      synthetic: () =>
        new RadixSyntheticTokenWriter(this.gateway, baseSigner, this.base),
    };

    const writer = writers[type];
    if (!writer) {
      return throwUnsupportedWarpType(type, ProtocolType.Radix);
    }

    return writer();
  }
}
