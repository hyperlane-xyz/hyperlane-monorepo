import { address as parseAddress } from '@solana/kit';

import type {
  LinearFeeConfig,
  ProgressiveFeeConfig,
  RegressiveFeeConfig,
} from '@hyperlane-xyz/provider-sdk/fee';
import { computeBps, FeeParamsType } from '@hyperlane-xyz/provider-sdk/fee';
import {
  type ArtifactDeployed,
  type ArtifactNew,
  ArtifactComposition,
  ArtifactState,
  type ConfigOnChain,
  type WithCompositionVariant,
  type ArtifactReader,
  type ArtifactWriter,
} from '@hyperlane-xyz/provider-sdk/artifact';
import {
  assert,
  eqAddressSol,
  eqOptionalAddress,
  isNullish,
  isZeroishAddress,
  ZERO_ADDRESS_HEX_32,
} from '@hyperlane-xyz/utils';

import type { SvmSigner } from '../clients/signer.js';
import { resolveProgram } from '../deploy/resolve-program.js';
import {
  buildBeneficiaryAtaIx,
  getInitFeeInstruction,
  getSetBeneficiaryInstruction,
  getTransferFeeOwnershipInstruction,
  getUpdateFeeParamsInstruction,
} from '../instructions/fee.js';
import { deriveFeeAccountPda } from '../pda.js';
import type { AnnotatedSvmTransaction, SvmReceipt, SvmRpc } from '../types.js';

import { fetchFeeAccount } from './fee-query.js';
import {
  feeStrategyTypeToKind,
  resolveRawFeeParams,
} from './fee-strategy-utils.js';
import {
  FeeDataKind,
  type SvmDeployedFee,
  type SvmFeeWriterConfig,
} from './types.js';

/**
 * Pure leaf fee configs — excludes OffchainQuotedLinearFeeConfig which has
 * a dedicated reader/writer due to the extra quoteSigners field.
 * All three types share an identical shape (type + owner + beneficiary + params),
 * so the `as C` cast in read() is structurally safe.
 */
export type LeafFeeConfig =
  | LinearFeeConfig
  | RegressiveFeeConfig
  | ProgressiveFeeConfig;

export abstract class SvmLeafFeeReader<
  C extends LeafFeeConfig,
> implements ArtifactReader<C, SvmDeployedFee> {
  readonly composition = ArtifactComposition.ORCHESTRATED;
  protected abstract readonly feeType: C['type'];

  constructor(
    protected readonly rpc: SvmRpc,
    protected readonly salt: Uint8Array,
  ) {}

  async read(
    address: string,
  ): Promise<
    ArtifactDeployed<
      ConfigOnChain<
        WithCompositionVariant<C, typeof ArtifactComposition.ORCHESTRATED>,
        SvmDeployedFee
      >,
      SvmDeployedFee
    >
  > {
    const programId = parseAddress(address);
    const account = await fetchFeeAccount(this.rpc, programId, this.salt);
    assert(account, `Fee account not found for program: ${programId}`);
    assert(
      account.feeData.kind === FeeDataKind.Leaf,
      `Expected Leaf fee data, got kind ${account.feeData.kind}`,
    );

    const expectedKind = feeStrategyTypeToKind(this.feeType);
    assert(
      account.feeData.strategy.kind === expectedKind,
      `Expected strategy kind ${expectedKind}, got ${account.feeData.strategy.kind}`,
    );
    assert(
      isNullish(account.feeData.signers),
      'Expected no signers for pure leaf fee (not offchainQuotedLinear)',
    );

    const { address: feeAccountPda } = await deriveFeeAccountPda(
      programId,
      this.salt,
    );
    const { maxFee, halfAmount } = account.feeData.strategy.params;
    const owner: string = account.owner ?? ZERO_ADDRESS_HEX_32;
    const beneficiary: string = account.beneficiary;

    // Return params in bps shape with raw values carried alongside. The
    // bps form is what cross-VM comparison (shouldDeployNewFee) keys on
    // when matched against user input that came in as `bps: N`. The raw
    // fields are populated from on-chain so callers that need exact raw
    // values (e.g. SVM writer's UpdateFeeParams diff) can read them
    // without re-deriving bps→raw.
    //
    // CAST: safe because LeafFeeConfig excludes OffchainQuotedLinearFeeConfig
    // and all three remaining types share an identical shape. The
    // WithCompositionVariant wrap narrows C to its ORCHESTRATED variant so
    // callers in the orchestrated-only paths get the precise config type.
    const maxFeeStr = maxFee.toString();
    const halfAmountStr = halfAmount.toString();
    return {
      artifactState: ArtifactState.DEPLOYED,
      config: {
        type: this.feeType,
        owner,
        beneficiary,
        params: {
          type: FeeParamsType.bps,
          bps: computeBps(maxFee, halfAmount),
          maxFee: maxFeeStr,
          halfAmount: halfAmountStr,
        },
      } as ConfigOnChain<
        WithCompositionVariant<C, typeof ArtifactComposition.ORCHESTRATED>,
        SvmDeployedFee
      >,
      deployed: { address: programId, programId, feeAccountPda },
    };
  }
}

export abstract class SvmLeafFeeWriter<C extends LeafFeeConfig>
  extends SvmLeafFeeReader<C>
  implements ArtifactWriter<C, SvmDeployedFee>
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
    artifact: ArtifactNew<
      WithCompositionVariant<C, typeof ArtifactComposition.ORCHESTRATED>
    >,
  ): Promise<
    [
      ArtifactDeployed<
        ConfigOnChain<
          WithCompositionVariant<C, typeof ArtifactComposition.ORCHESTRATED>,
          SvmDeployedFee
        >,
        SvmDeployedFee
      >,
      SvmReceipt[],
    ]
  > {
    const feeConfig = artifact.config;
    const { programAddress: programId, receipts } = await resolveProgram(
      this.writerConfig.program,
      this.svmSigner,
      this.rpc,
      true,
    );

    const strategyKind = feeStrategyTypeToKind(this.feeType);
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
            strategy: { kind: strategyKind, params: resolved },
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

    // Ensure the beneficiary's ATA exists when the fee config carries the
    // settlement asset. No-op when `token` is undefined (native flows) or
    // when the ATA already exists on chain.
    const initAtaIx = await buildBeneficiaryAtaIx({
      rpc: this.rpc,
      payer: this.svmSigner.signer.address,
      beneficiary: parseAddress(feeConfig.beneficiary),
      feeToken: feeConfig.token,
    });
    if (initAtaIx) {
      receipts.push(await this.svmSigner.send({ instructions: [initAtaIx] }));
    }

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
        // CAST: LeafFeeConfig has no nested Artifact<> positions, so
        // ConfigOnChain<X, D> is structurally identical to X. TS can't
        // reduce a generic mapped type, so an explicit cast bridges the
        // two equivalent shapes.
        config: feeConfig as ConfigOnChain<
          WithCompositionVariant<C, typeof ArtifactComposition.ORCHESTRATED>,
          SvmDeployedFee
        >,
        deployed: { address: programId, programId, feeAccountPda },
      },
      receipts,
    ];
  }

  async update(
    artifact: ArtifactDeployed<
      WithCompositionVariant<C, typeof ArtifactComposition.ORCHESTRATED>,
      SvmDeployedFee
    >,
  ): Promise<AnnotatedSvmTransaction[]> {
    const txs: AnnotatedSvmTransaction[] = [];
    const expected = artifact.config;
    const { programId, feeAccountPda } = artifact.deployed;

    const current = await this.read(programId);
    // CAST: LeafFeeConfig has no nested Artifact<> positions, so
    // ConfigOnChain<X, D> is structurally identical to X. TS can't
    // reduce a generic mapped type at indexing time, so an explicit
    // narrowing bridges the two equivalent shapes.
    const currentConfig = current.config as WithCompositionVariant<
      C,
      typeof ArtifactComposition.ORCHESTRATED
    >;

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
        annotation: `Update ${this.feeType} fee params`,
      });
    }

    // 2. Diff beneficiary + ensure beneficiary's ATA exists when token is set.
    const expectedBeneficiary = parseAddress(expected.beneficiary);
    // payer = current on-chain owner: every tx generated by the artifact
    // API's update path is paid for and signed by the owner, since the
    // owner is the only authority that can mutate the artifact. The
    // create path uses the deployer as payer because there is no on-chain
    // owner yet — that asymmetry is the design invariant, not a bug.
    const ataIx = await buildBeneficiaryAtaIx({
      rpc: this.rpc,
      payer: ownerAddress,
      beneficiary: expectedBeneficiary,
      feeToken: expected.token,
    });
    const beneficiaryChanged = !eqAddressSol(
      currentConfig.beneficiary,
      expected.beneficiary,
    );

    if (beneficiaryChanged) {
      const setBeneficiaryIx = getSetBeneficiaryInstruction(
        programId,
        feeAccountPda,
        ownerAddress,
        expectedBeneficiary,
      );
      txs.push({
        feePayer: ownerAddress,
        instructions: ataIx ? [ataIx, setBeneficiaryIx] : [setBeneficiaryIx],
        annotation: ataIx
          ? 'Update fee beneficiary and create ata'
          : 'Update fee beneficiary',
      });
    } else if (ataIx) {
      txs.push({
        feePayer: ownerAddress,
        instructions: [ataIx],
        annotation: 'Create beneficiary ata',
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
