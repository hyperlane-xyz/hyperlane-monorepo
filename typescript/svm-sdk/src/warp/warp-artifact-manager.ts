import { address, type Rpc, type SolanaRpcApi } from '@solana/kit';

import { ProtocolType } from '@hyperlane-xyz/provider-sdk';
import type {
  ArtifactReader,
  ArtifactWriter,
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
import type { SvmSigner } from '../clients/signer.js';
import { resolveFeeSalt } from '../fee/types.js';
import { HYPERLANE_SVM_PROGRAM_BYTES } from '../hyperlane/program-bytes.js';
import {
  SvmCollateralTokenReader,
  SvmCollateralTokenWriter,
} from './collateral-token.js';
import {
  SvmCrossCollateralTokenReader,
  SvmCrossCollateralTokenWriter,
} from './cross-collateral-token.js';
import { SvmNativeTokenReader, SvmNativeTokenWriter } from './native-token.js';
import {
  SvmSyntheticTokenReader,
  SvmSyntheticTokenWriter,
} from './synthetic-token.js';
import { detectWarpTokenType } from './warp-query.js';

export class SvmWarpArtifactManager implements IRawWarpArtifactManager {
  constructor(
    private readonly rpc: Rpc<SolanaRpcApi>,
    chainConfig: { chainName: string },
    private readonly ataPayerFundingAmount: bigint = 100_000_000n,
    private readonly feeSalt: Uint8Array = resolveFeeSalt(
      chainConfig.chainName,
    ),
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
    const readers: WarpArtifactReaderFactories = {
      native: () => new SvmNativeTokenReader(this.rpc),
      synthetic: () => new SvmSyntheticTokenReader(this.rpc),
      collateral: () => new SvmCollateralTokenReader(this.rpc),
      crossCollateral: () => new SvmCrossCollateralTokenReader(this.rpc),
    };

    const reader = readers[type];
    if (!reader) {
      return throwUnsupportedWarpType(type, ProtocolType.Sealevel);
    }

    return reader();
  }

  createWriter<T extends WarpType>(
    type: T,
    signer: SvmSigner,
  ): ArtifactWriter<RawWarpArtifactConfigs[T], DeployedWarpAddress> {
    const writers: WarpArtifactWriterFactories = {
      native: () =>
        new SvmNativeTokenWriter(
          {
            program: { programBytes: HYPERLANE_SVM_PROGRAM_BYTES.tokenNative },
            ataPayerFundingAmount: this.ataPayerFundingAmount,
            feeSalt: this.feeSalt,
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
            feeSalt: this.feeSalt,
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
            feeSalt: this.feeSalt,
          },
          this.rpc,
          signer,
        ),
      crossCollateral: () =>
        new SvmCrossCollateralTokenWriter(
          {
            program: {
              programBytes: HYPERLANE_SVM_PROGRAM_BYTES.tokenCrossCollateral,
            },
            ataPayerFundingAmount: this.ataPayerFundingAmount,
            feeSalt: this.feeSalt,
          },
          this.rpc,
          signer,
        ),
    };

    const writer = writers[type];
    if (!writer) {
      return throwUnsupportedWarpType(type, ProtocolType.Sealevel);
    }

    return writer();
  }

  supportsHookUpdates(): boolean {
    return true;
  }
}
