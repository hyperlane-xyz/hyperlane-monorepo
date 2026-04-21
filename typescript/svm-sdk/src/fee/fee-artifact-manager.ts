import { address as parseAddress } from '@solana/kit';

import {
  type FeeType,
  type DeployedFeeAddress,
  type DeployedFeeArtifact,
  type FeeArtifactConfigs,
  type FeeReadContext,
  type IRawFeeArtifactManager,
} from '@hyperlane-xyz/provider-sdk/fee';
import type {
  ArtifactReader,
  ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import { assert } from '@hyperlane-xyz/utils';

import { HYPERLANE_SVM_PROGRAM_BYTES } from '../hyperlane/program-bytes.js';
import type { SvmSigner } from '../clients/signer.js';
import type { SvmRpc } from '../types.js';

import {
  SvmCrossCollateralRoutingFeeReader,
  SvmCrossCollateralRoutingFeeWriter,
} from './cross-collateral-routing-fee.js';
import { detectSvmFeeType, fetchFeeAccount } from './fee-query.js';
import { SvmLinearFeeReader, SvmLinearFeeWriter } from './linear-fee.js';
import {
  SvmOffchainQuotedLinearFeeReader,
  SvmOffchainQuotedLinearFeeWriter,
} from './offchain-quoted-linear-fee.js';
import {
  SvmProgressiveFeeReader,
  SvmProgressiveFeeWriter,
} from './progressive-fee.js';
import {
  SvmRegressiveFeeReader,
  SvmRegressiveFeeWriter,
} from './regressive-fee.js';
import { SvmRoutingFeeReader, SvmRoutingFeeWriter } from './routing-fee.js';
import { DEFAULT_FEE_SALT } from './types.js';

export class SvmFeeArtifactManager implements IRawFeeArtifactManager {
  constructor(
    private readonly rpc: SvmRpc,
    private readonly context: FeeReadContext,
    private readonly domainId: number,
    private readonly salt: Uint8Array = DEFAULT_FEE_SALT,
  ) {}

  async readFee(
    address: string,
    context: FeeReadContext,
  ): Promise<DeployedFeeArtifact> {
    const programId = parseAddress(address);
    const account = await fetchFeeAccount(this.rpc, programId, this.salt);
    assert(account, `Fee account not found for program: ${address}`);

    const feeType = detectSvmFeeType(account.feeData);
    // Use the caller-provided context (may differ from this.context for routing reads)
    return this.buildReader(feeType, context).read(address);
  }

  createReader<T extends FeeType>(
    type: T,
  ): ArtifactReader<FeeArtifactConfigs[T], DeployedFeeAddress> {
    return this.buildReader(type, this.context);
  }

  createWriter<T extends FeeType>(
    type: T,
    signer: SvmSigner,
  ): ArtifactWriter<FeeArtifactConfigs[T], DeployedFeeAddress> {
    const program = { programBytes: HYPERLANE_SVM_PROGRAM_BYTES.tokenFee };

    const writers: {
      [K in FeeType]: () => ArtifactWriter<
        FeeArtifactConfigs[K],
        DeployedFeeAddress
      >;
    } = {
      linear: () =>
        new SvmLinearFeeWriter(
          { program },
          this.rpc,
          this.domainId,
          signer,
          this.salt,
        ),
      regressive: () =>
        new SvmRegressiveFeeWriter(
          { program },
          this.rpc,
          this.domainId,
          signer,
          this.salt,
        ),
      progressive: () =>
        new SvmProgressiveFeeWriter(
          { program },
          this.rpc,
          this.domainId,
          signer,
          this.salt,
        ),
      offchainQuotedLinear: () =>
        new SvmOffchainQuotedLinearFeeWriter(
          { program },
          this.rpc,
          this.domainId,
          signer,
          this.salt,
        ),
      routing: () =>
        new SvmRoutingFeeWriter(
          { program },
          this.rpc,
          this.domainId,
          signer,
          this.context,
          this.salt,
        ),
      crossCollateralRouting: () =>
        new SvmCrossCollateralRoutingFeeWriter(
          { program },
          this.rpc,
          this.domainId,
          signer,
          this.context,
          this.salt,
        ),
    };

    return writers[type]();
  }

  private buildReader<T extends FeeType>(
    type: T,
    context: FeeReadContext,
  ): ArtifactReader<FeeArtifactConfigs[T], DeployedFeeAddress> {
    const readers: {
      [K in FeeType]: () => ArtifactReader<
        FeeArtifactConfigs[K],
        DeployedFeeAddress
      >;
    } = {
      linear: () => new SvmLinearFeeReader(this.rpc, this.salt),
      regressive: () => new SvmRegressiveFeeReader(this.rpc, this.salt),
      progressive: () => new SvmProgressiveFeeReader(this.rpc, this.salt),
      offchainQuotedLinear: () =>
        new SvmOffchainQuotedLinearFeeReader(this.rpc, this.salt),
      routing: () => new SvmRoutingFeeReader(this.rpc, context, this.salt),
      crossCollateralRouting: () =>
        new SvmCrossCollateralRoutingFeeReader(this.rpc, context, this.salt),
    };

    return readers[type]();
  }
}
