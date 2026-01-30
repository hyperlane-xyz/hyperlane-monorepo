import { GatewayApiClient } from '@radixdlt/babylon-gateway-api-sdk';

import {
  ArtifactReader,
  ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  DeployedWarpAddress,
  DeployedWarpArtifact,
  IRawWarpArtifactManager,
  RawWarpArtifactConfigs,
  WarpType,
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

  async readWarpToken(address: string): Promise<DeployedWarpArtifact> {
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
    const readers: {
      [K in WarpType]: () => ArtifactReader<
        RawWarpArtifactConfigs[K],
        DeployedWarpAddress
      >;
    } = {
      collateral: () => new RadixCollateralTokenReader(this.gateway, this.base),
      synthetic: () => new RadixSyntheticTokenReader(this.gateway, this.base),
      native: () => {
        throw new Error('Native tokens are not supported on Radix');
      },
    };

    return readers[type]();
  }

  createWriter<T extends WarpType>(
    type: T,
    signer: RadixSigner,
  ): ArtifactWriter<RawWarpArtifactConfigs[T], DeployedWarpAddress> {
    const baseSigner = signer.getBaseSigner();

    const writers: {
      [K in WarpType]: () => ArtifactWriter<
        RawWarpArtifactConfigs[K],
        DeployedWarpAddress
      >;
    } = {
      collateral: () =>
        new RadixCollateralTokenWriter(this.gateway, baseSigner, this.base),
      synthetic: () =>
        new RadixSyntheticTokenWriter(this.gateway, baseSigner, this.base),
      native: () => {
        throw new Error('Native tokens are not supported on Radix');
      },
    };

    return writers[type]();
  }
}
