import type { Address, Instruction } from '@solana/kit';
import { getAddressCodec, getNullableCodec } from '@solana/kit';

import {
  concatBytes,
  i64le,
  option,
  u8,
  u32le,
  u64le,
  vecBytes,
} from '../codecs/binary.js';
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
  deriveStandingQuotePda,
  deriveTransientQuotePda,
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
    return [writableAccount(feeAccount), writableSignerAddress(owner)];
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

// ── SetCrossCollateralRoute ─────────────────────────────────────────
// Accounts:
//   0. `[]`           System program
//   1. `[]`           Fee account (read-only, must be FeeData::CrossCollateralRouting)
//   2. `[writable, signer]` Owner
//   3. `[writable]`   CrossCollateralRoute PDA (created if uninitialized, updated if exists)

export async function getSetCrossCollateralRouteInstruction(
  programId: Address,
  feeAccount: Address,
  owner: Address,
  destination: number,
  targetRouter: Uint8Array,
  feeData: SvmFeeDataStrategy,
  signers: Uint8Array[] | null,
): Promise<Instruction> {
  const { address: ccRoutePda } = await deriveCrossCollateralRoutePda(
    programId,
    feeAccount,
    destination,
    targetRouter,
  );

  const ixData = concatBytes(
    u8(FeeInstructionKind.SetCrossCollateralRoute),
    u32le(destination),
    Uint8Array.from(targetRouter),
    encodeFeeDataStrategy(feeData),
    encodeOptionalBTreeSetH160(signers),
  );

  return buildInstruction(
    programId,
    [
      readonlyAccount(SYSTEM_PROGRAM_ADDRESS),
      readonlyAccount(feeAccount),
      writableSignerAddress(owner),
      writableAccount(ccRoutePda),
    ],
    ixData,
  );
}

// ── RemoveCrossCollateralRoute ──────────────────────────────────────
// Accounts:
//   0. `[]`           Fee account (read-only, must be FeeData::CrossCollateralRouting)
//   1. `[writable, signer]` Owner (receives rent refund)
//   2. `[writable]`   CrossCollateralRoute PDA (closed)

export async function getRemoveCrossCollateralRouteInstruction(
  programId: Address,
  feeAccount: Address,
  owner: Address,
  destination: number,
  targetRouter: Uint8Array,
): Promise<Instruction> {
  const { address: ccRoutePda } = await deriveCrossCollateralRoutePda(
    programId,
    feeAccount,
    destination,
    targetRouter,
  );

  const ixData = concatBytes(
    u8(FeeInstructionKind.RemoveCrossCollateralRoute),
    u32le(destination),
    Uint8Array.from(targetRouter),
  );

  return buildInstruction(
    programId,
    [
      readonlyAccount(feeAccount),
      writableSignerAddress(owner),
      writableAccount(ccRoutePda),
    ],
    ixData,
  );
}

// ── SetMinIssuedAt ──────────────────────────────────────────────────
// Accounts:
//   0. `[writable]`   Fee account
//   1. `[signer]`     Owner

export function getSetMinIssuedAtInstruction(
  programId: Address,
  feeAccount: Address,
  owner: Address,
  minIssuedAt: bigint,
): Instruction {
  const ixData = concatBytes(
    u8(FeeInstructionKind.SetMinIssuedAt),
    i64le(minIssuedAt),
  );

  return buildInstruction(
    programId,
    [writableAccount(feeAccount), readonlySignerAddress(owner)],
    ixData,
  );
}

// ── SubmitQuote (transient) ─────────────────────────────────────────
// Accounts:
//   0. `[]`           System program
//   1. `[writable, signer]` Payer
//   2. `[]`           Fee account (read-only for transient)
//   3..N. `[]`        Route PDAs (Routing: 1 RouteDomain; CC: specific + default; Leaf: none)
//   N+1. `[writable]` Transient quote PDA

export interface SvmSignedQuoteData {
  context: Uint8Array;
  data: Uint8Array;
  issuedAt: Uint8Array; // 6 bytes, u48 BE
  expiry: Uint8Array; // 6 bytes, u48 BE
  clientSalt: Uint8Array; // 32 bytes
  signature: Uint8Array; // 65 bytes
}

function encodeSvmSignedQuote(quote: SvmSignedQuoteData): Uint8Array {
  return Uint8Array.from(
    concatBytes(
      vecBytes(quote.context),
      vecBytes(quote.data),
      Uint8Array.from(quote.issuedAt),
      Uint8Array.from(quote.expiry),
      Uint8Array.from(quote.clientSalt),
      Uint8Array.from(quote.signature),
    ),
  );
}

export async function getSubmitTransientQuoteInstruction(
  programId: Address,
  payer: Address,
  feeAccount: Address,
  scopedSalt: Uint8Array,
  quote: SvmSignedQuoteData,
  routePdas: Address[],
): Promise<Instruction> {
  const { address: transientPda } = await deriveTransientQuotePda(
    programId,
    feeAccount,
    scopedSalt,
  );

  const ixData = concatBytes(
    u8(FeeInstructionKind.SubmitQuote),
    encodeSvmSignedQuote(quote),
  );

  return buildInstruction(
    programId,
    [
      readonlyAccount(SYSTEM_PROGRAM_ADDRESS),
      writableSignerAddress(payer),
      readonlyAccount(feeAccount),
      ...routePdas.map(readonlyAccount),
      writableAccount(transientPda),
    ],
    ixData,
  );
}

// ── SubmitQuote (standing) ──────────────────────────────────────────
// Accounts:
//   0. `[]`           System program
//   1. `[writable, signer]` Payer
//   2. `[writable/readonly]` Fee account (writable for Leaf/Routing, readonly for CC)
//   3..N. `[]`        Route PDAs
//   N+1. `[writable]` Standing quote PDA

export async function getSubmitStandingQuoteInstruction(
  programId: Address,
  payer: Address,
  feeAccount: Address,
  domain: number,
  targetRouter: Uint8Array,
  quote: SvmSignedQuoteData,
  routePdas: Address[],
  feeAccountWritable: boolean,
): Promise<Instruction> {
  const { address: standingPda } = await deriveStandingQuotePda(
    programId,
    feeAccount,
    domain,
    targetRouter,
  );

  const ixData = concatBytes(
    u8(FeeInstructionKind.SubmitQuote),
    encodeSvmSignedQuote(quote),
  );

  const feeAccountMeta = feeAccountWritable
    ? writableAccount(feeAccount)
    : readonlyAccount(feeAccount);

  return buildInstruction(
    programId,
    [
      readonlyAccount(SYSTEM_PROGRAM_ADDRESS),
      writableSignerAddress(payer),
      feeAccountMeta,
      ...routePdas.map(readonlyAccount),
      writableAccount(standingPda),
    ],
    ixData,
  );
}

// ── CloseTransientQuote ─────────────────────────────────────────────
// Accounts:
//   0. `[]`           Fee account
//   1. `[writable]`   Transient quote PDA
//   2. `[signer]`     Original payer (receives rent refund)

export function getCloseTransientQuoteInstruction(
  programId: Address,
  feeAccount: Address,
  transientPda: Address,
  payerRefund: Address,
): Instruction {
  return buildInstruction(
    programId,
    [
      readonlyAccount(feeAccount),
      writableAccount(transientPda),
      writableSignerAddress(payerRefund),
    ],
    u8(FeeInstructionKind.CloseTransientQuote),
  );
}

// ── PruneExpiredQuotes ──────────────────────────────────────────────
// Accounts:
//   0. `[]`           System program
//   1. `[writable]`   Fee account
//   2. `[writable, signer]` Owner (receives rent if PDA closed)
//   3. `[writable]`   Standing quote PDA
//
// target_router in data: Some(H256) for CC, None for Leaf/Routing.
// When None, standing PDA is derived with H256::zero() as target_router.

export async function getPruneExpiredQuotesInstruction(
  programId: Address,
  feeAccount: Address,
  owner: Address,
  domain: number,
  targetRouter: Uint8Array | null,
): Promise<Instruction> {
  const resolvedRouter = targetRouter ?? new Uint8Array(32);
  const { address: standingPda } = await deriveStandingQuotePda(
    programId,
    feeAccount,
    domain,
    resolvedRouter,
  );

  const ixData = concatBytes(
    u8(FeeInstructionKind.PruneExpiredQuotes),
    u32le(domain),
    option(targetRouter, (r) => Uint8Array.from(r)),
  );

  return buildInstruction(
    programId,
    [
      readonlyAccount(SYSTEM_PROGRAM_ADDRESS),
      writableAccount(feeAccount),
      writableSignerAddress(owner),
      writableAccount(standingPda),
    ],
    ixData,
  );
}

// ── GetQuoteAccountMetas (simulation-only) ──────────────────────────
// Accounts:
//   0. `[]` Fee account

export function getGetQuoteAccountMetasInstruction(
  programId: Address,
  feeAccount: Address,
  destinationDomain: number,
  targetRouter: Uint8Array,
  scopedSalt: Uint8Array | null,
): Instruction {
  const ixData = concatBytes(
    u8(FeeInstructionKind.GetQuoteAccountMetas),
    u32le(destinationDomain),
    Uint8Array.from(targetRouter),
    option(scopedSalt, (s) => Uint8Array.from(s)),
  );

  return buildInstruction(programId, [readonlyAccount(feeAccount)], ixData);
}

// ── GetSubmitQuoteAccountMetas (simulation-only) ────────────────────
// Accounts:
//   0. `[]` Fee account

export function getGetSubmitQuoteAccountMetasInstruction(
  programId: Address,
  feeAccount: Address,
  destinationDomain: number,
  targetRouter: Uint8Array,
  scopedSalt: Uint8Array | null,
): Instruction {
  const ixData = concatBytes(
    u8(FeeInstructionKind.GetSubmitQuoteAccountMetas),
    u32le(destinationDomain),
    Uint8Array.from(targetRouter),
    option(scopedSalt, (s) => Uint8Array.from(s)),
  );

  return buildInstruction(programId, [readonlyAccount(feeAccount)], ixData);
}

// ── QuoteFee (CPI-called, but exposed for testing) ──────────────────
// Accounts (variable):
//   0. `[]`           Fee account
//   1. `[writable, signer]` Payer
//   2. (optional) `[writable]` Transient quote PDA
//   N. `[]`           Domain standing quote PDA (may be uninitialized)
//   N+1. `[]`         Wildcard standing quote PDA (may be uninitialized)
//   (Routing) +1: `[]` RouteDomain PDA
//   (CC) +2: `[]` CC specific route PDA + CC default route PDA

export interface QuoteFeeAccounts {
  transientPda?: Address;
  domainStandingPda: Address;
  wildcardStandingPda: Address;
  routePdas: Address[];
}

export function getQuoteFeeInstruction(
  programId: Address,
  feeAccount: Address,
  payer: Address,
  destinationDomain: number,
  recipient: Uint8Array,
  amount: bigint,
  targetRouter: Uint8Array,
  quoteFeeAccounts: QuoteFeeAccounts,
): Instruction {
  const ixData = concatBytes(
    u8(FeeInstructionKind.QuoteFee),
    u32le(destinationDomain),
    Uint8Array.from(recipient),
    u64le(amount),
    Uint8Array.from(targetRouter),
  );

  const accounts = [readonlyAccount(feeAccount), writableSignerAddress(payer)];

  if (quoteFeeAccounts.transientPda) {
    accounts.push(writableAccount(quoteFeeAccounts.transientPda));
  }
  accounts.push(readonlyAccount(quoteFeeAccounts.domainStandingPda));
  accounts.push(readonlyAccount(quoteFeeAccounts.wildcardStandingPda));
  for (const pda of quoteFeeAccounts.routePdas) {
    accounts.push(readonlyAccount(pda));
  }

  return buildInstruction(programId, accounts, ixData);
}
