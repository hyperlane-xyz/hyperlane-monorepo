import { address as parseAddress } from '@solana/kit';

import {
  FeeParamsType,
  FeeType,
  type OffchainQuotedLinearFeeConfig,
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
import { SetQuoteSignerOp } from '../codecs/fee.js';
import { resolveProgram } from '../deploy/resolve-program.js';
import {
  getInitFeeInstruction,
  getSetBeneficiaryInstruction,
  getSetQuoteSignerInstruction,
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
  h160ToSigner,
  signerToH160,
  type SvmDeployedFee,
  type SvmFeeWriterConfig,
} from './types.js';

export class SvmOffchainQuotedLinearFeeReader implements ArtifactReader<
  OffchainQuotedLinearFeeConfig,
  SvmDeployedFee
> {
  constructor(
    protected readonly rpc: SvmRpc,
    protected readonly salt: Uint8Array,
  ) {}

  async read(
    address: string,
  ): Promise<ArtifactDeployed<OffchainQuotedLinearFeeConfig, SvmDeployedFee>> {
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
      account.feeData.signers !== null,
      'Expected signers for offchainQuotedLinear, got null',
    );

    const { address: feeAccountPda } = await deriveFeeAccountPda(
      programId,
      this.salt,
    );
    const { maxFee, halfAmount } = account.feeData.strategy.params;
    const owner: string = account.owner ?? ZERO_ADDRESS_HEX_32;
    const beneficiary: string = account.beneficiary;

    return {
      artifactState: ArtifactState.DEPLOYED,
      config: {
        type: FeeType.offchainQuotedLinear,
        owner,
        beneficiary,
        params: {
          type: FeeParamsType.raw,
          maxFee: maxFee.toString(),
          halfAmount: halfAmount.toString(),
        },
        quoteSigners: account.feeData.signers.map(h160ToSigner),
      },
      deployed: { address: programId, programId, feeAccountPda },
    };
  }
}

export class SvmOffchainQuotedLinearFeeWriter
  extends SvmOffchainQuotedLinearFeeReader
  implements ArtifactWriter<OffchainQuotedLinearFeeConfig, SvmDeployedFee>
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
    artifact: ArtifactNew<OffchainQuotedLinearFeeConfig>,
  ): Promise<
    [
      ArtifactDeployed<OffchainQuotedLinearFeeConfig, SvmDeployedFee>,
      SvmReceipt[],
    ]
  > {
    const feeConfig = artifact.config;
    const { programAddress: programId, receipts } = await resolveProgram(
      this.writerConfig.program,
      this.svmSigner,
      this.rpc,
    );

    const signerBytes = feeConfig.quoteSigners.map(signerToH160);
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
            signers: signerBytes,
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

    if (
      !eqOptionalAddress(
        this.svmSigner.signer.address,
        feeConfig.owner,
        eqAddressSol,
      )
    ) {
      const newOwner =
        feeConfig.owner && !isZeroishAddress(feeConfig.owner)
          ? parseAddress(feeConfig.owner)
          : null;
      receipts.push(
        await this.svmSigner.send({
          instructions: [
            getTransferFeeOwnershipInstruction(
              programId,
              feeAccountPda,
              this.svmSigner.signer.address,
              newOwner,
            ),
          ],
        }),
      );
    }

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
    artifact: ArtifactDeployed<OffchainQuotedLinearFeeConfig, SvmDeployedFee>,
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
        annotation: 'Update offchainQuotedLinear fee params',
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

    // 3. Diff quote signers (incremental add/remove)
    const currentSigners = new Set(
      currentConfig.quoteSigners.map((s) => s.toLowerCase()),
    );
    const expectedSigners = new Set(
      expected.quoteSigners.map((s) => s.toLowerCase()),
    );

    for (const signer of expectedSigners) {
      if (!currentSigners.has(signer)) {
        txs.push({
          feePayer: ownerAddress,
          instructions: [
            getSetQuoteSignerInstruction(
              programId,
              feeAccountPda,
              ownerAddress,
              SetQuoteSignerOp.Add,
              signerToH160(signer),
            ),
          ],
          annotation: `Add quote signer ${signer}`,
        });
      }
    }

    for (const signer of currentSigners) {
      if (!expectedSigners.has(signer)) {
        txs.push({
          feePayer: ownerAddress,
          instructions: [
            getSetQuoteSignerInstruction(
              programId,
              feeAccountPda,
              ownerAddress,
              SetQuoteSignerOp.Remove,
              signerToH160(signer),
            ),
          ],
          annotation: `Remove quote signer ${signer}`,
        });
      }
    }

    // 4. Diff owner (always last)
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
