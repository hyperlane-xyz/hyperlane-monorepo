import { address, type Rpc, type SolanaRpcApi } from '@solana/kit';

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

import type { SvmSigner } from '../clients/signer.js';
import { HYPERLANE_SVM_PROGRAM_BYTES } from '../hyperlane/program-bytes.js';
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

export class SvmWarpArtifactManager implements IRawWarpArtifactManager {
  constructor(
    private readonly rpc: Rpc<SolanaRpcApi>,
    private readonly ataPayerFundingAmount: bigint = 100_000_000n,
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
      crossCollateral: () => {
        throw new Error('Cross-collateral tokens are not yet supported on SVM');
      },
    };

    return readers[type]();
  }

  createWriter<T extends WarpType>(
    type: T,
    signer: SvmSigner,
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
            program: { programBytes: HYPERLANE_SVM_PROGRAM_BYTES.tokenNative },
            ataPayerFundingAmount: this.ataPayerFundingAmount,
          },
          this.rpc,
          signer,
        ),
      synthetic: () =>
        new SvmSyntheticTokenWriter(
          {
            program: {
              programBytes: HYPERLANE_SVM_PROGRAM_BYTES.tokenSynthetic,
            },
            ataPayerFundingAmount: this.ataPayerFundingAmount,
          },
          this.rpc,
          signer,
        ),
      collateral: () =>
        new SvmCollateralTokenWriter(
          {
            program: {
              programBytes: HYPERLANE_SVM_PROGRAM_BYTES.tokenCollateral,
            },
            ataPayerFundingAmount: this.ataPayerFundingAmount,
          },
          this.rpc,
          signer,
        ),
      crossCollateral: () => {
        throw new Error('Cross-collateral tokens are not yet supported on SVM');
      },
    };

    return writers[type]();
  }

  supportsHookUpdates(): boolean {
    return true;
  }
}
