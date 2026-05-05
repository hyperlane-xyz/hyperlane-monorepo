import type {
  Address,
  Instruction,
  ReadonlyUint8Array,
  TransactionSigner,
} from '@solana/kit';
import { getAddressCodec } from '@solana/kit';

import { concatBytes, i64le, option, u8, u32le } from '../codecs/binary.js';
import {
  encodeBTreeSetH160,
  encodeFeeData,
  encodeFeeDataStrategy,
  encodeFeeParams,
  encodeRouteKey,
  encodeSetQuoteSignerOperation,
  type SetQuoteSignerOp,
  type SvmFeeData,
  type SvmFeeDataStrategy,
  type SvmFeeParams,
  type SvmRouteKey,
  SvmRouteKeyKind,
} from '../codecs/fee.js';
import { SYSTEM_PROGRAM_ADDRESS } from '../constants.js';
import {
  deriveCrossCollateralRoutePda,
  deriveFeeAccountPda,
  deriveRouteDomainPda,
  deriveStandingQuotePda,
} from '../pda.js';
import {
  buildInstruction,
  readonlyAccount,
  readonlySignerAddress,
  writableAccount,
  writableSigner,
  writableSignerAddress,
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

// ====== SetQuoteSigner (Leaf mode — route = None) ======

export function getSetQuoteSignerInstruction(
  programId: Address,
  feeAccount: Address,
  owner: Address,
  operation: SetQuoteSignerOp,
  signer: Uint8Array,
): Instruction {
  return buildInstruction(
    programId,
    [
      readonlyAccount(SYSTEM_PROGRAM_ADDRESS),
      writableAccount(feeAccount),
      writableSignerAddress(owner),
    ],
    concatBytes(
      u8(FeeInstructionKind.SetQuoteSigner),
      encodeSetQuoteSignerOperation(operation, signer),
      u8(0), // Option::None for route (Leaf mode)
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

// ====== SetRemoteFeeRoute ======

const H256_ZERO = new Uint8Array(32);

export async function getSetRemoteFeeRouteInstruction(
  programId: Address,
  feeAccount: Address,
  owner: Address,
  domain: number,
  targetRouter: Uint8Array | null,
  feeData: SvmFeeDataStrategy,
  signers: Uint8Array[] | null,
): Promise<Instruction> {
  const { address: routePda } = await deriveRouteDomainPda(
    programId,
    feeAccount,
    domain,
  );
  const { address: standingQuotePda } = await deriveStandingQuotePda(
    programId,
    feeAccount,
    domain,
    targetRouter ?? H256_ZERO,
  );
  return buildInstruction(
    programId,
    [
      readonlyAccount(SYSTEM_PROGRAM_ADDRESS),
      readonlyAccount(feeAccount),
      writableSignerAddress(owner),
      writableAccount(routePda),
      writableAccount(standingQuotePda),
    ],
    concatBytes(
      u8(FeeInstructionKind.SetRemoteFeeRoute),
      u32le(domain),
      option(targetRouter, (r) => r),
      encodeFeeDataStrategy(feeData),
      option(signers, encodeBTreeSetH160),
    ),
  );
}

// ====== RemoveRemoteFeeRoute ======

export async function getRemoveRemoteFeeRouteInstruction(
  programId: Address,
  feeAccount: Address,
  owner: Address,
  domain: number,
  targetRouter: Uint8Array | null,
): Promise<Instruction> {
  const { address: routePda } = await deriveRouteDomainPda(
    programId,
    feeAccount,
    domain,
  );
  const { address: standingQuotePda } = await deriveStandingQuotePda(
    programId,
    feeAccount,
    domain,
    targetRouter ?? H256_ZERO,
  );
  return buildInstruction(
    programId,
    [
      readonlyAccount(feeAccount),
      writableSignerAddress(owner),
      writableAccount(routePda),
      writableAccount(standingQuotePda),
    ],
    concatBytes(
      u8(FeeInstructionKind.RemoveRemoteFeeRoute),
      u32le(domain),
      option(targetRouter, (r) => r),
    ),
  );
}

// ====== SetWildcardQuoteSigners ======

export function getSetWildcardQuoteSignersInstruction(
  programId: Address,
  feeAccount: Address,
  owner: Address,
  signers: Uint8Array[],
): Instruction {
  return buildInstruction(
    programId,
    [
      readonlyAccount(SYSTEM_PROGRAM_ADDRESS),
      writableAccount(feeAccount),
      writableSignerAddress(owner),
    ],
    concatBytes(
      u8(FeeInstructionKind.SetWildcardQuoteSigners),
      encodeBTreeSetH160(signers),
    ),
  );
}

// ====== SetQuoteSigner (Routing mode — route = Some(Domain)) ======

export async function getSetQuoteSignerForRouteInstruction(
  programId: Address,
  feeAccount: Address,
  owner: Address,
  operation: SetQuoteSignerOp,
  signer: Uint8Array,
  route: SvmRouteKey,
): Promise<Instruction> {
  let routePda: Address;
  switch (route.kind) {
    case SvmRouteKeyKind.Domain:
      routePda = (
        await deriveRouteDomainPda(programId, feeAccount, route.domain)
      ).address;
      break;
    case SvmRouteKeyKind.CrossCollateral:
      routePda = (
        await deriveCrossCollateralRoutePda(
          programId,
          feeAccount,
          route.destination,
          route.targetRouter,
        )
      ).address;
      break;
    default: {
      const _exhaustive: never = route;
      throw new Error(`Unhandled route kind: ${String(_exhaustive)}`);
    }
  }
  return buildInstruction(
    programId,
    [
      readonlyAccount(SYSTEM_PROGRAM_ADDRESS),
      readonlyAccount(feeAccount),
      writableSignerAddress(owner),
      writableAccount(routePda),
    ],
    concatBytes(
      u8(FeeInstructionKind.SetQuoteSigner),
      encodeSetQuoteSignerOperation(operation, signer),
      option(route, encodeRouteKey),
    ),
  );
}
