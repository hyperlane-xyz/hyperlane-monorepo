import type { Address, Instruction } from '@solana/kit';
import { getAddressCodec, getNullableCodec } from '@solana/kit';

import { concatBytes, u8, u32le } from '../codecs/binary.js';
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
  writableSignerAddress,
} from './utils.js';

// ── Shared codecs ───────────────────────────────────────────────────

const ADDRESS_CODEC = getAddressCodec();
const OPTIONAL_ADDRESS_CODEC = getNullableCodec(ADDRESS_CODEC);

// ── Instruction enum discriminants ──────────────────────────────────

export const FeeInstructionKind = {
  InitFee: 0,
  QuoteFee: 1,
  SetRoute: 2,
  RemoveRoute: 3,
  SetCrossCollateralRoute: 4,
  RemoveCrossCollateralRoute: 5,
  UpdateFeeParams: 6,
  SetBeneficiary: 7,
  TransferOwnership: 8,
  AddQuoteSigner: 9,
  RemoveQuoteSigner: 10,
  SetMinIssuedAt: 11,
  SetWildcardQuoteSigners: 12,
  SubmitQuote: 13,
  CloseTransientQuote: 14,
  PruneExpiredQuotes: 15,
  GetQuoteAccountMetas: 16,
  GetSubmitQuoteAccountMetas: 17,
} as const;

// ── InitFee ─────────────────────────────────────────────────────────
// Accounts: [system(r), payer(ws), fee_account_pda(w)]

export interface InitFeeData {
  salt: Uint8Array;
  beneficiary: Address;
  feeData: SvmFeeData;
  domainId: number;
}

export async function getInitFeeInstruction(
  programId: Address,
  payer: Address,
  data: InitFeeData,
): Promise<Instruction> {
  const { address: feeAccountPda } = await deriveFeeAccountPda(
    programId,
    data.salt,
  );

  const ixData = concatBytes(
    u8(FeeInstructionKind.InitFee),
    Uint8Array.from(data.salt),
    ADDRESS_CODEC.encode(data.beneficiary),
    encodeFeeData(data.feeData),
    u32le(data.domainId),
  );

  return buildInstruction(
    programId,
    [
      readonlyAccount(SYSTEM_PROGRAM_ADDRESS),
      writableSignerAddress(payer),
      writableAccount(feeAccountPda),
    ],
    ixData,
  );
}

// ── UpdateFeeParams ─────────────────────────────────────────────────
// Accounts: [fee_account(w), owner(rs)]

export function getUpdateFeeParamsInstruction(
  programId: Address,
  feeAccount: Address,
  owner: Address,
  params: SvmFeeParams,
): Instruction {
  const ixData = concatBytes(
    u8(FeeInstructionKind.UpdateFeeParams),
    encodeFeeParams(params),
  );

  return buildInstruction(
    programId,
    [writableAccount(feeAccount), readonlySignerAddress(owner)],
    ixData,
  );
}

// ── SetBeneficiary ──────────────────────────────────────────────────
// Accounts: [fee_account(w), owner(rs)]

export function getSetBeneficiaryInstruction(
  programId: Address,
  feeAccount: Address,
  owner: Address,
  beneficiary: Address,
): Instruction {
  const ixData = concatBytes(
    u8(FeeInstructionKind.SetBeneficiary),
    ADDRESS_CODEC.encode(beneficiary),
  );

  return buildInstruction(
    programId,
    [writableAccount(feeAccount), readonlySignerAddress(owner)],
    ixData,
  );
}

// ── TransferOwnership ───────────────────────────────────────────────
// Accounts: [fee_account(w), owner(rs)]

export function getTransferFeeOwnershipInstruction(
  programId: Address,
  feeAccount: Address,
  owner: Address,
  newOwner: Address | null,
): Instruction {
  const ixData = concatBytes(
    u8(FeeInstructionKind.TransferOwnership),
    OPTIONAL_ADDRESS_CODEC.encode(newOwner),
  );

  return buildInstruction(
    programId,
    [writableAccount(feeAccount), readonlySignerAddress(owner)],
    ixData,
  );
}
