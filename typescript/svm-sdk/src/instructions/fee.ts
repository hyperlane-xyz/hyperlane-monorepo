import type {
  Address,
  Instruction,
  ReadonlyUint8Array,
  TransactionSigner,
} from '@solana/kit';
import { getAddressCodec } from '@solana/kit';

import { concatBytes, i64le, option, u8, u32le } from '../codecs/binary.js';
import {
  encodeFeeData,
  encodeFeeParams,
  type SvmFeeData,
  type SvmFeeParams,
} from '../codecs/fee.js';
import { SYSTEM_PROGRAM_ADDRESS } from '../constants.js';
import { deriveFeeAccountPda } from '../pda.js';
import {
  buildInstruction,
  readonlyAccount,
  readonlySignerAddress,
  writableAccount,
  writableSigner,
} from './utils.js';

const ADDRESS_CODEC = getAddressCodec();

/** On-chain instruction discriminants — full enum for forward reference. */
export const FeeInstructionKind = {
  InitFee: 0,
  QuoteFee: 1,
  SetRemoteFeeRoute: 2,
  RemoveRemoteFeeRoute: 3,
  UpdateFeeParams: 4,
  SetBeneficiary: 5,
  TransferOwnership: 6,
  SetQuoteSigner: 7,
  SetMinIssuedAt: 8,
  SetWildcardQuoteSigners: 9,
  SubmitQuote: 10,
  CloseTransientQuote: 11,
  PruneExpiredQuotes: 12,
  GetQuoteAccountMetas: 13,
  GetSubmitQuoteAccountMetas: 14,
} as const;

// ====== InitFee ======

export interface InitFeeData {
  salt: Uint8Array;
  beneficiary: Address;
  feeData: SvmFeeData;
  domainId: number;
}

function encodeInitFee(data: InitFeeData): ReadonlyUint8Array {
  return concatBytes(
    data.salt,
    ADDRESS_CODEC.encode(data.beneficiary),
    encodeFeeData(data.feeData),
    u32le(data.domainId),
  );
}

export async function getInitFeeInstruction(
  programId: Address,
  payer: TransactionSigner,
  data: InitFeeData,
): Promise<Instruction> {
  const { address: feeAccountPda } = await deriveFeeAccountPda(
    programId,
    data.salt,
  );
  return buildInstruction(
    programId,
    [
      readonlyAccount(SYSTEM_PROGRAM_ADDRESS),
      writableSigner(payer),
      writableAccount(feeAccountPda),
    ],
    concatBytes(u8(FeeInstructionKind.InitFee), encodeInitFee(data)),
  );
}

// ====== UpdateFeeParams (Leaf-only) ======

export function getUpdateFeeParamsInstruction(
  programId: Address,
  feeAccount: Address,
  owner: Address,
  params: SvmFeeParams,
): Instruction {
  return buildInstruction(
    programId,
    [writableAccount(feeAccount), readonlySignerAddress(owner)],
    concatBytes(
      u8(FeeInstructionKind.UpdateFeeParams),
      encodeFeeParams(params),
    ),
  );
}

// ====== SetBeneficiary ======

export function getSetBeneficiaryInstruction(
  programId: Address,
  feeAccount: Address,
  owner: Address,
  beneficiary: Address,
): Instruction {
  return buildInstruction(
    programId,
    [writableAccount(feeAccount), readonlySignerAddress(owner)],
    concatBytes(
      u8(FeeInstructionKind.SetBeneficiary),
      ADDRESS_CODEC.encode(beneficiary),
    ),
  );
}

// ====== TransferOwnership ======

export function getTransferFeeOwnershipInstruction(
  programId: Address,
  feeAccount: Address,
  owner: Address,
  newOwner: Address | null,
): Instruction {
  return buildInstruction(
    programId,
    [writableAccount(feeAccount), readonlySignerAddress(owner)],
    concatBytes(
      u8(FeeInstructionKind.TransferOwnership),
      option(newOwner, (addr) => ADDRESS_CODEC.encode(addr)),
    ),
  );
}

// ====== SetMinIssuedAt ======

export function getSetMinIssuedAtInstruction(
  programId: Address,
  feeAccount: Address,
  owner: Address,
  minIssuedAt: bigint,
): Instruction {
  return buildInstruction(
    programId,
    [writableAccount(feeAccount), readonlySignerAddress(owner)],
    concatBytes(u8(FeeInstructionKind.SetMinIssuedAt), i64le(minIssuedAt)),
  );
}
