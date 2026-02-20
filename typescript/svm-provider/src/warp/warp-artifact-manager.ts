import type { Address, Rpc, SolanaRpcApi } from '@solana/kit';

import type {
  ArtifactReader,
  ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import type {
  DeployedRawWarpArtifact,
  DeployedWarpAddress,
  IRawWarpArtifactManager,
  RawWarpArtifactConfigs,
  WarpType,
} from '@hyperlane-xyz/provider-sdk/warp';

import {
  SvmCollateralTokenReader,
  SvmCollateralTokenWriter,
} from './collateral-token.js';
import { SvmNativeTokenReader, SvmNativeTokenWriter } from './native-token.js';
import { PROGRAM_BYTES } from './program-bytes.js';
import {
  SvmSyntheticTokenReader,
  SvmSyntheticTokenWriter,
} from './synthetic-token.js';
import { SvmWarpTokenType, detectWarpTokenType } from './warp-query.js';

export class SvmWarpArtifactManager implements IRawWarpArtifactManager {
  constructor(
    private readonly rpc: Rpc<SolanaRpcApi>,
    private readonly rpcUrl: string,
  ) {}

  async readWarpToken(address: string): Promise<DeployedRawWarpArtifact> {
    const programId = address as Address;
    const tokenType = await detectWarpTokenType(this.rpc, programId);

    switch (tokenType) {
      case SvmWarpTokenType.Native:
        return this.createReader('native').read(address);
      case SvmWarpTokenType.Synthetic:
        return this.createReader('synthetic').read(address);
      case SvmWarpTokenType.Collateral:
        return this.createReader('collateral').read(address);
    }

    throw new Error('Unknown token type');
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
      native: () => new SvmNativeTokenReader(this.rpc),
      synthetic: () => new SvmSyntheticTokenReader(this.rpc, this.rpcUrl),
      collateral: () => new SvmCollateralTokenReader(this.rpc),
    };

    return readers[type]();
  }

  createWriter<T extends WarpType>(
    type: T,
    // FIXME: Using any here because we still don't have a proper svm signer implemented
    signer: any,
  ): ArtifactWriter<RawWarpArtifactConfigs[T], DeployedWarpAddress> {
    const writers: {
      [K in WarpType]: () => ArtifactWriter<
        RawWarpArtifactConfigs[K],
        DeployedWarpAddress
      >;
    } = {
      native: () =>
        new SvmNativeTokenWriter(this.rpc, signer, PROGRAM_BYTES.nativeToken),
      synthetic: () =>
        new SvmSyntheticTokenWriter(
          this.rpc,
          signer,
          PROGRAM_BYTES.syntheticToken,
          this.rpcUrl,
        ),
      collateral: () =>
        new SvmCollateralTokenWriter(
          this.rpc,
          signer,
          PROGRAM_BYTES.collateralToken,
        ),
    };

    return writers[type]();
  }
}
