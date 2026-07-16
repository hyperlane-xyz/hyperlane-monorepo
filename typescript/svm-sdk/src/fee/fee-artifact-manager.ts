import { address as parseAddress } from '@solana/kit';

import {
  type DeployedFeeAddress,
  type DeployedFeeArtifact,
  type FeeArtifactConfigs,
  type FeeReadContext,
  FeeType,
  type IRawFeeArtifactManager,
} from '@hyperlane-xyz/provider-sdk/fee';
import type {
  ArtifactReader,
  ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import { assert } from '@hyperlane-xyz/utils';

import type { SvmSigner } from '../clients/signer.js';
import { HYPERLANE_SVM_PROGRAM_BYTES } from '../hyperlane/program-bytes.js';
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

export class SvmFeeArtifactManager implements IRawFeeArtifactManager {
  constructor(
    private readonly rpc: SvmRpc,
    private readonly context: FeeReadContext,
    private readonly chainConfig: { domainId: number; chainName: string },
    private readonly salt: Uint8Array,
  ) {}

  async readFee(
    address: string,
    context: FeeReadContext,
  ): Promise<DeployedFeeArtifact> {
    const programId = parseAddress(address);
    const account = await fetchFeeAccount(this.rpc, programId, this.salt);
    assert(account, `Fee account not found for program: ${address}`);

    const feeType = detectSvmFeeType(account.feeData);
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
    const { domainId } = this.chainConfig;

    const writers: {
      [K in FeeType]: () => ArtifactWriter<
        FeeArtifactConfigs[K],
        DeployedFeeAddress
      >;
    } = {
      [FeeType.linear]: () =>
        new SvmLinearFeeWriter(
          { program },
          this.rpc,
          domainId,
          signer,
          this.salt,
        ),
      [FeeType.regressive]: () =>
        new SvmRegressiveFeeWriter(
          { program },
          this.rpc,
          domainId,
          signer,
          this.salt,
        ),
      [FeeType.progressive]: () =>
        new SvmProgressiveFeeWriter(
          { program },
          this.rpc,
          domainId,
          signer,
          this.salt,
        ),
      [FeeType.offchainQuotedLinear]: () =>
        new SvmOffchainQuotedLinearFeeWriter(
          { program },
          this.rpc,
          domainId,
          signer,
          this.salt,
        ),
      [FeeType.routing]: () =>
        new SvmRoutingFeeWriter(
          { program },
          this.rpc,
          domainId,
          signer,
          this.context,
          this.salt,
        ),
      [FeeType.crossCollateralRouting]: () =>
        new SvmCrossCollateralRoutingFeeWriter(
          { program },
          this.rpc,
          domainId,
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
      [FeeType.linear]: () => new SvmLinearFeeReader(this.rpc, this.salt),
      [FeeType.regressive]: () =>
        new SvmRegressiveFeeReader(this.rpc, this.salt),
      [FeeType.progressive]: () =>
        new SvmProgressiveFeeReader(this.rpc, this.salt),
      [FeeType.offchainQuotedLinear]: () =>
        new SvmOffchainQuotedLinearFeeReader(this.rpc, this.salt),
      [FeeType.routing]: () =>
        new SvmRoutingFeeReader(this.rpc, context, this.salt),
      [FeeType.crossCollateralRouting]: () =>
        new SvmCrossCollateralRoutingFeeReader(this.rpc, context, this.salt),
    };

    return readers[type]();
  }
}
