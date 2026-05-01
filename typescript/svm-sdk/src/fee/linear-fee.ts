import { address as parseAddress } from '@solana/kit';

import {
  type LinearFeeConfig,
  FeeParamsType,
  FeeType,
} from '@hyperlane-xyz/provider-sdk/fee';
import {
  type ArtifactDeployed,
  type ArtifactNew,
  type ArtifactReader,
  ArtifactState,
  type ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  assert,
  eqAddressSol,
  eqOptionalAddress,
  isZeroishAddress,
  ZERO_ADDRESS_HEX_32,
} from '@hyperlane-xyz/utils';

import type { SvmSigner } from '../clients/signer.js';
import { resolveProgram } from '../deploy/resolve-program.js';
import {
  getInitFeeInstruction,
  getSetBeneficiaryInstruction,
  getTransferFeeOwnershipInstruction,
  getUpdateFeeParamsInstruction,
} from '../instructions/fee.js';
import { deriveFeeAccountPda } from '../pda.js';
import type { AnnotatedSvmTransaction, SvmReceipt, SvmRpc } from '../types.js';

import { fetchFeeAccount } from './fee-query.js';
import { resolveRawFeeParams } from './fee-strategy-utils.js';
import {
  FeeDataKind,
  FeeStrategyKind,
  type SvmDeployedFee,
  type SvmFeeWriterConfig,
} from './types.js';

export class SvmLinearFeeReader implements ArtifactReader<
  LinearFeeConfig,
  SvmDeployedFee
> {
  constructor(
    protected readonly rpc: SvmRpc,
    protected readonly salt: Uint8Array,
  ) {}

  async read(
    address: string,
  ): Promise<ArtifactDeployed<LinearFeeConfig, SvmDeployedFee>> {
    const programId = parseAddress(address);
    const account = await fetchFeeAccount(this.rpc, programId, this.salt);
    assert(account, `Fee account not found for program: ${programId}`);
    assert(
      account.feeData.kind === FeeDataKind.Leaf,
      `Expected Leaf fee data, got kind ${account.feeData.kind}`,
    );
    assert(
      account.feeData.strategy.kind === FeeStrategyKind.Linear,
      `Expected Linear strategy, got kind ${account.feeData.strategy.kind}`,
    );
    assert(
      account.feeData.signers === null,
      'Expected no signers for LinearFee (not offchainQuotedLinear)',
    );

    const { address: feeAccountPda } = await deriveFeeAccountPda(
      programId,
      this.salt,
    );

    const { maxFee, halfAmount } = account.feeData.strategy.params;

    return {
      artifactState: ArtifactState.DEPLOYED,
      config: {
        type: FeeType.linear,
        owner: account.owner ?? ZERO_ADDRESS_HEX_32,
        beneficiary: account.beneficiary,
        params: {
          type: FeeParamsType.raw,
          maxFee: maxFee.toString(),
          halfAmount: halfAmount.toString(),
        },
      },
      deployed: { address: programId, programId, feeAccountPda },
    };
  }
}

export class SvmLinearFeeWriter
  extends SvmLinearFeeReader
  implements ArtifactWriter<LinearFeeConfig, SvmDeployedFee>
{
  constructor(
    private readonly writerConfig: SvmFeeWriterConfig,
    rpc: SvmRpc,
    private readonly domainId: number,
    private readonly svmSigner: SvmSigner,
    salt: Uint8Array,
  ) {
    super(rpc, salt);
  }

  async create(
    artifact: ArtifactNew<LinearFeeConfig>,
  ): Promise<
    [ArtifactDeployed<LinearFeeConfig, SvmDeployedFee>, SvmReceipt[]]
  > {
    const feeConfig = artifact.config;
    const { programAddress: programId, receipts } = await resolveProgram(
      this.writerConfig.program,
      this.svmSigner,
      this.rpc,
    );

    const resolved = resolveRawFeeParams(feeConfig.params);
    const initIx = await getInitFeeInstruction(
      programId,
      this.svmSigner.signer,
      {
        salt: this.salt,
        beneficiary: parseAddress(feeConfig.beneficiary),
        feeData: {
          kind: FeeDataKind.Leaf,
          config: {
            strategy: { kind: FeeStrategyKind.Linear, params: resolved },
            signers: null,
          },
        },
        domainId: this.domainId,
      },
    );

    receipts.push(
      await this.svmSigner.send({
        instructions: [initIx],
        skipPreflight: true,
      }),
    );

    const { address: feeAccountPda } = await deriveFeeAccountPda(
      programId,
      this.salt,
    );

    return [
      {
        artifactState: ArtifactState.DEPLOYED,
        config: feeConfig,
        deployed: { address: programId, programId, feeAccountPda },
      },
      receipts,
    ];
  }

  async update(
    artifact: ArtifactDeployed<LinearFeeConfig, SvmDeployedFee>,
  ): Promise<AnnotatedSvmTransaction[]> {
    const txs: AnnotatedSvmTransaction[] = [];
    const expected = artifact.config;
    const { programId, feeAccountPda } = artifact.deployed;

    const current = await this.read(programId);
    const currentConfig = current.config;

    assert(
      !isZeroishAddress(currentConfig.owner),
      'Cannot update fee: fee account has no owner',
    );
    const ownerAddress = parseAddress(currentConfig.owner);

    // 1. Diff fee params
    const currentResolved = resolveRawFeeParams(currentConfig.params);
    const expectedResolved = resolveRawFeeParams(expected.params);
    if (
      currentResolved.maxFee !== expectedResolved.maxFee ||
      currentResolved.halfAmount !== expectedResolved.halfAmount
    ) {
      txs.push({
        feePayer: ownerAddress,
        instructions: [
          getUpdateFeeParamsInstruction(
            programId,
            feeAccountPda,
            ownerAddress,
            expectedResolved,
          ),
        ],
        annotation: 'Update LinearFee params',
      });
    }

    // 2. Diff beneficiary
    if (!eqAddressSol(currentConfig.beneficiary, expected.beneficiary)) {
      txs.push({
        feePayer: ownerAddress,
        instructions: [
          getSetBeneficiaryInstruction(
            programId,
            feeAccountPda,
            ownerAddress,
            parseAddress(expected.beneficiary),
          ),
        ],
        annotation: 'Update fee beneficiary',
      });
    }

    // 3. Diff owner (always last)
    if (!eqOptionalAddress(currentConfig.owner, expected.owner, eqAddressSol)) {
      const newOwner =
        expected.owner && !isZeroishAddress(expected.owner)
          ? parseAddress(expected.owner)
          : null;
      txs.push({
        feePayer: ownerAddress,
        instructions: [
          getTransferFeeOwnershipInstruction(
            programId,
            feeAccountPda,
            ownerAddress,
            newOwner,
          ),
        ],
        annotation: 'Transfer fee ownership',
      });
    }

    return txs;
  }
}
