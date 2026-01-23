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

import type { AnyAleoNetworkClient } from '../clients/base.js';
import type { AleoSigner } from '../clients/signer.js';
import { aleoTokenTypeToWarpType } from '../utils/helper.js';

import {
  AleoCollateralTokenReader,
  AleoCollateralTokenWriter,
} from './collateral-token.js';
import {
  AleoNativeTokenReader,
  AleoNativeTokenWriter,
} from './native-token.js';
import {
  AleoSyntheticTokenReader,
  AleoSyntheticTokenWriter,
} from './synthetic-token.js';
import { getAleoWarpTokenType } from './warp-query.js';

export class AleoWarpArtifactManager implements IRawWarpArtifactManager {
  constructor(
    private readonly aleoClient: AnyAleoNetworkClient,
    private readonly ismManager: string,
  ) {}

  async readWarpToken(address: string): Promise<DeployedWarpArtifact> {
    // Detect warp token type first
    const aleoTokenType = await getAleoWarpTokenType(this.aleoClient, address);

    // Convert to provider-sdk WarpType
    const warpType = aleoTokenTypeToWarpType(aleoTokenType);

    // Get the appropriate reader and read the token
    const reader = this.createReader(warpType);
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
      native: () => new AleoNativeTokenReader(this.aleoClient, this.ismManager),
      collateral: () =>
        new AleoCollateralTokenReader(this.aleoClient, this.ismManager),
      synthetic: () =>
        new AleoSyntheticTokenReader(this.aleoClient, this.ismManager),
    };

    return readers[type]();
  }

  createWriter<T extends WarpType>(
    type: T,
    signer: AleoSigner,
  ): ArtifactWriter<RawWarpArtifactConfigs[T], DeployedWarpAddress> {
    const writers: {
      [K in WarpType]: () => ArtifactWriter<
        RawWarpArtifactConfigs[K],
        DeployedWarpAddress
      >;
    } = {
      native: () =>
        new AleoNativeTokenWriter(this.aleoClient, signer, this.ismManager),
      collateral: () =>
        new AleoCollateralTokenWriter(this.aleoClient, signer, this.ismManager),
      synthetic: () =>
        new AleoSyntheticTokenWriter(this.aleoClient, signer, this.ismManager),
    };

    return writers[type]();
  }
}
