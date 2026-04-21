import type { Address, Instruction } from '@solana/kit';
import { getAddressCodec, getNullableCodec } from '@solana/kit';

import { concatBytes, u8, u32le } from '../codecs/binary.js';
import {
  encodeBTreeSetH160,
  encodeFeeData,
  encodeFeeDataStrategy,
  encodeFeeParams,
  encodeOptionalBTreeSetH160,
  encodeOptionalRouteKey,
  type SvmFeeData,
  type SvmFeeDataStrategy,
  type SvmFeeParams,
  type SvmRouteKey,
} from '../codecs/fee.js';
import { SYSTEM_PROGRAM_ADDRESS } from '../constants.js';
import {
  deriveFeeAccountPda,
  deriveCrossCollateralRoutePda,
  deriveRouteDomainPda,
} from '../pda.js';

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

// ── AddQuoteSigner ──────────────────────────────────────────────────
// Accounts when route=None (Leaf mode):
//   0. `[]`           System program
//   1. `[writable]`   Fee account (signers stored directly on it)
//   2. `[writable, signer]` Owner
//
// Accounts when route=Some(Domain) (Routing mode):
//   0. `[]`           System program
//   1. `[]`           Fee account (read-only, signers on route PDA)
//   2. `[writable, signer]` Owner
//   3. `[writable]`   RouteDomain PDA
//
// Accounts when route=Some(CrossCollateral) (CC mode):
//   0. `[]`           System program
//   1. `[]`           Fee account (read-only, signers on CC route PDA)
//   2. `[writable, signer]` Owner
//   3. `[writable]`   CrossCollateralRoute PDA

export async function getAddQuoteSignerInstruction(
  programId: Address,
  feeAccount: Address,
  owner: Address,
  signer: Uint8Array,
  route: SvmRouteKey | null,
): Promise<Instruction> {
  const ixData = concatBytes(
    u8(FeeInstructionKind.AddQuoteSigner),
    Uint8Array.from(signer),
    encodeOptionalRouteKey(route),
  );

  return buildInstruction(
    programId,
    await buildAddQuoteSignerAccounts(programId, feeAccount, owner, route),
    ixData,
  );
}

// ── RemoveQuoteSigner ───────────────────────────────────────────────
// Accounts when route=None (Leaf mode):
//   0. `[writable]`   Fee account
//   1. `[writable, signer]` Owner
//
// Accounts when route=Some(Domain) (Routing mode):
//   0. `[]`           Fee account (read-only)
//   1. `[writable, signer]` Owner
//   2. `[writable]`   RouteDomain PDA
//
// Accounts when route=Some(CrossCollateral) (CC mode):
//   0. `[]`           Fee account (read-only)
//   1. `[writable, signer]` Owner
//   2. `[writable]`   CrossCollateralRoute PDA

export async function getRemoveQuoteSignerInstruction(
  programId: Address,
  feeAccount: Address,
  owner: Address,
  signer: Uint8Array,
  route: SvmRouteKey | null,
): Promise<Instruction> {
  const ixData = concatBytes(
    u8(FeeInstructionKind.RemoveQuoteSigner),
    Uint8Array.from(signer),
    encodeOptionalRouteKey(route),
  );

  return buildInstruction(
    programId,
    await buildRemoveQuoteSignerAccounts(programId, feeAccount, owner, route),
    ixData,
  );
}

async function buildAddQuoteSignerAccounts(
  programId: Address,
  feeAccount: Address,
  owner: Address,
  route: SvmRouteKey | null,
) {
  if (!route) {
    return [
      readonlyAccount(SYSTEM_PROGRAM_ADDRESS),
      writableAccount(feeAccount),
      writableSignerAddress(owner),
    ];
  }

  const routePda =
    route.kind === 'domain'
      ? await deriveRouteDomainPda(programId, feeAccount, route.domain)
      : await deriveCrossCollateralRoutePda(
          programId,
          feeAccount,
          route.destination,
          route.targetRouter,
        );

  return [
    readonlyAccount(SYSTEM_PROGRAM_ADDRESS),
    readonlyAccount(feeAccount),
    writableSignerAddress(owner),
    writableAccount(routePda.address),
  ];
}

async function buildRemoveQuoteSignerAccounts(
  programId: Address,
  feeAccount: Address,
  owner: Address,
  route: SvmRouteKey | null,
) {
  if (!route) {
    return [
      writableAccount(feeAccount),
      writableSignerAddress(owner),
    ];
  }

  const routePda =
    route.kind === 'domain'
      ? await deriveRouteDomainPda(programId, feeAccount, route.domain)
      : await deriveCrossCollateralRoutePda(
          programId,
          feeAccount,
          route.destination,
          route.targetRouter,
        );

  return [
    readonlyAccount(feeAccount),
    writableSignerAddress(owner),
    writableAccount(routePda.address),
  ];
}

// ── SetRoute ────────────────────────────────────────────────────────
// Accounts:
//   0. `[]`           System program
//   1. `[]`           Fee account (read-only, must be FeeData::Routing)
//   2. `[writable, signer]` Owner
//   3. `[writable]`   RouteDomain PDA (created if uninitialized, updated if exists)

export async function getSetRouteInstruction(
  programId: Address,
  feeAccount: Address,
  owner: Address,
  domain: number,
  feeData: SvmFeeDataStrategy,
  signers: Uint8Array[] | null,
): Promise<Instruction> {
  const { address: routePda } = await deriveRouteDomainPda(
    programId,
    feeAccount,
    domain,
  );

  const ixData = concatBytes(
    u8(FeeInstructionKind.SetRoute),
    u32le(domain),
    encodeFeeDataStrategy(feeData),
    encodeOptionalBTreeSetH160(signers),
  );

  return buildInstruction(
    programId,
    [
      readonlyAccount(SYSTEM_PROGRAM_ADDRESS),
      readonlyAccount(feeAccount),
      writableSignerAddress(owner),
      writableAccount(routePda),
    ],
    ixData,
  );
}

// ── RemoveRoute ─────────────────────────────────────────────────────
// Accounts:
//   0. `[]`           Fee account (read-only, must be FeeData::Routing)
//   1. `[writable, signer]` Owner (receives rent refund)
//   2. `[writable]`   RouteDomain PDA (closed)

export async function getRemoveRouteInstruction(
  programId: Address,
  feeAccount: Address,
  owner: Address,
  domain: number,
): Promise<Instruction> {
  const { address: routePda } = await deriveRouteDomainPda(
    programId,
    feeAccount,
    domain,
  );

  const ixData = concatBytes(u8(FeeInstructionKind.RemoveRoute), u32le(domain));

  return buildInstruction(
    programId,
    [
      readonlyAccount(feeAccount),
      writableSignerAddress(owner),
      writableAccount(routePda),
    ],
    ixData,
  );
}

// ── SetWildcardQuoteSigners ─────────────────────────────────────────
// Accounts:
//   0. `[]`           System program
//   1. `[writable]`   Fee account (must be Routing or CrossCollateralRouting)
//   2. `[writable, signer]` Owner

export function getSetWildcardQuoteSignersInstruction(
  programId: Address,
  feeAccount: Address,
  owner: Address,
  signers: Uint8Array[],
): Instruction {
  const ixData = concatBytes(
    u8(FeeInstructionKind.SetWildcardQuoteSigners),
    encodeBTreeSetH160(signers),
  );

  return buildInstruction(
    programId,
    [
      readonlyAccount(SYSTEM_PROGRAM_ADDRESS),
      writableAccount(feeAccount),
      writableSignerAddress(owner),
    ],
    ixData,
  );
}
