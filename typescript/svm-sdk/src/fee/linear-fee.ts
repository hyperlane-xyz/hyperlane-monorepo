import { address as parseAddress } from '@solana/kit';

import { FeeType, type LinearFeeConfig } from '@hyperlane-xyz/provider-sdk/fee';
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
import {
  DEFAULT_FEE_SALT,
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
    protected readonly salt: Uint8Array = DEFAULT_FEE_SALT,
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

    const { address: feeAccountPda } = await deriveFeeAccountPda(
      programId,
      this.salt,
    );

    return {
      artifactState: ArtifactState.DEPLOYED,
      config: {
        type: FeeType.linear,
        owner: account.owner ?? ZERO_ADDRESS_HEX_32,
        beneficiary: account.beneficiary,
        maxFee: account.feeData.strategy.params.maxFee.toString(),
        halfAmount: account.feeData.strategy.params.halfAmount.toString(),
      },
      deployed: {
        address: programId,
        programId,
        feeAccountPda,
      },
    };
  }
}

export class SvmLinearFeeWriter
  extends SvmLinearFeeReader
  implements ArtifactWriter<LinearFeeConfig, SvmDeployedFee>
{
  constructor(
    private readonly config: SvmFeeWriterConfig,
    rpc: SvmRpc,
    private readonly domainId: number,
    private readonly svmSigner: SvmSigner,
    salt: Uint8Array = DEFAULT_FEE_SALT,
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
      this.config.program,
      this.svmSigner,
      this.rpc,
    );

    const initIx = await getInitFeeInstruction(
      programId,
      this.svmSigner.signer.address,
      {
        salt: this.salt,
        beneficiary: parseAddress(feeConfig.beneficiary),
        feeData: {
          kind: FeeDataKind.Leaf,
          config: {
            strategy: {
              kind: FeeStrategyKind.Linear,
              params: {
                maxFee: BigInt(feeConfig.maxFee),
                halfAmount: BigInt(feeConfig.halfAmount),
              },
            },
            signers: null,
          },
        },
        domainId: this.domainId,
      },
    );

    const initReceipt = await this.svmSigner.send({
      instructions: [initIx],
      skipPreflight: true,
    });
    receipts.push(initReceipt);

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

    // Phase 1: Diff fee params
    if (
      currentConfig.maxFee !== expected.maxFee ||
      currentConfig.halfAmount !== expected.halfAmount
    ) {
      txs.push({
        feePayer: ownerAddress,
        instructions: [
          getUpdateFeeParamsInstruction(
            programId,
            feeAccountPda,
            ownerAddress,
            {
              maxFee: BigInt(expected.maxFee),
              halfAmount: BigInt(expected.halfAmount),
            },
          ),
        ],
        annotation: 'Update linear fee params',
      });
    }

    // Phase 2: Diff beneficiary
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

    // Phase 3: Diff owner (always last)
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
