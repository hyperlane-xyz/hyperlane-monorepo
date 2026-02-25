import {
  address,
  type Address,
  type Rpc,
  type SolanaRpcApi,
} from '@solana/kit';

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
import {
  SvmSyntheticTokenReader,
  SvmSyntheticTokenWriter,
} from './synthetic-token.js';
import { detectWarpTokenType } from './warp-query.js';
import { PROGRAM_BYTES } from '../hyperlane/program-bytes.js';

export class SvmWarpArtifactManager implements IRawWarpArtifactManager {
  constructor(
    private readonly rpc: Rpc<SolanaRpcApi>,
    private readonly igpProgramId: Address,
  ) {}

  async readWarpToken(tokenAddress: string): Promise<DeployedRawWarpArtifact> {
    const tokenType = await detectWarpTokenType(
      this.rpc,
      address(tokenAddress),
    );

    const reader = this.createReader(tokenType);
    return reader.read(tokenAddress);
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
      synthetic: () => new SvmSyntheticTokenReader(this.rpc),
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
        new SvmNativeTokenWriter(
          {
            igpProgramId: this.igpProgramId,
            program: { programBytes: PROGRAM_BYTES.tokenNative },
          },
          this.rpc,
          signer,
        ),
      synthetic: () =>
        new SvmSyntheticTokenWriter(
          {
            igpProgramId: this.igpProgramId,
            program: { programBytes: PROGRAM_BYTES.token },
          },
          this.rpc,
          signer,
        ),
      collateral: () =>
        new SvmCollateralTokenWriter(
          {
            igpProgramId: this.igpProgramId,
            program: { programBytes: PROGRAM_BYTES.tokenCollateral },
          },
          this.rpc,
          signer,
        ),
    };

    return writers[type]();
  }
}
