import type {
  Address,
  Base64EncodedWireTransaction,
  Instruction,
  ReadonlyUint8Array,
  TransactionSigner,
} from '@solana/kit';
import {
  appendTransactionMessageInstructions,
  blockhash,
  compileTransactionMessage,
  createTransactionMessage,
  getAddressCodec,
  getCompiledTransactionMessageEncoder,
  getShortU16Encoder,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';

import { assert } from '@hyperlane-xyz/utils';

import { readAddress } from '../codecs/account-data.js';
import {
  ByteCursor,
  concatBytes,
  i64le,
  option,
  u8,
  u32le,
} from '../codecs/binary.js';
import {
  encodeBTreeSetH160,
  encodeFeeData,
  encodeFeeDataStrategy,
  encodeFeeParams,
  encodeRouteKey,
  encodeSetQuoteSignerOperation,
  encodeSvmSignedQuote,
  type SetQuoteSignerOp,
  type SvmFeeData,
  type SvmFeeDataStrategy,
  type SvmFeeParams,
  type SvmRouteKey,
  SvmRouteKeyKind,
  type SvmSignedQuote,
} from '../codecs/fee.js';
import { SYSTEM_PROGRAM_ADDRESS } from '../constants.js';
import {
  deriveCrossCollateralRoutePda,
  deriveFeeAccountPda,
  deriveRouteDomainPda,
  deriveStandingQuotePda,
} from '../pda.js';
import type { SvmRpc } from '../types.js';
import {
  buildInstruction,
  type InstructionAccountMeta,
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
  assert(
    data.salt.length === 32,
    `salt must be 32 bytes, got ${data.salt.length}`,
  );
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

// ====== SetQuoteSigner (Leaf mode — route = None) ======

export function getSetQuoteSignerInstruction(
  programId: Address,
  feeAccount: Address,
  owner: Address,
  operation: SetQuoteSignerOp,
  signer: string,
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
  signers: string[] | null,
): Promise<Instruction> {
  const { address: routePda } = targetRouter
    ? await deriveCrossCollateralRoutePda(
        programId,
        feeAccount,
        domain,
        targetRouter,
      )
    : await deriveRouteDomainPda(programId, feeAccount, domain);
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
  const { address: routePda } = targetRouter
    ? await deriveCrossCollateralRoutePda(
        programId,
        feeAccount,
        domain,
        targetRouter,
      )
    : await deriveRouteDomainPda(programId, feeAccount, domain);
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
  signers: string[],
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
  signer: string,
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

// ====== GetQuoteAccountMetas (simulation-only) ======

const H256_LEN = 32;
const SCOPED_SALT_LEN = 32;

/** Input for the simulation-only `GetQuoteAccountMetas` instruction. */
export interface GetQuoteAccountMetasInput {
  destinationDomain: number;
  /** Remote warp route contract address (H256, 32 bytes). */
  targetRouter: Uint8Array;
  /** When set, the simulator includes the transient quote PDA for this scoped salt. */
  scopedSalt?: Uint8Array;
}

export function encodeGetQuoteAccountMetasInput(
  input: GetQuoteAccountMetasInput,
): Uint8Array {
  assert(
    input.targetRouter.length === H256_LEN,
    `targetRouter must be ${H256_LEN} bytes`,
  );
  if (input.scopedSalt !== undefined) {
    assert(
      input.scopedSalt.length === SCOPED_SALT_LEN,
      `scopedSalt must be ${SCOPED_SALT_LEN} bytes`,
    );
  }
  return Uint8Array.from(
    concatBytes(
      u32le(input.destinationDomain),
      input.targetRouter,
      option(input.scopedSalt ?? null, (salt) => salt),
    ),
  );
}

export function getGetQuoteAccountMetasInstruction(
  programAddress: Address,
  feeAccount: Address,
  input: GetQuoteAccountMetasInput,
): Instruction {
  return buildInstruction(
    programAddress,
    [readonlyAccount(feeAccount)],
    concatBytes(
      u8(FeeInstructionKind.GetQuoteAccountMetas),
      encodeGetQuoteAccountMetasInput(input),
    ),
  );
}

/** Mirror of the Rust `SerializableAccountMeta` returned by fee simulation. */
export interface SimulatedFeeAccountMeta {
  pubkey: Address;
  isSigner: boolean;
  isWritable: boolean;
}

/**
 * Runs the fee program's `GetQuoteAccountMetas` instruction via transaction
 * simulation and parses the returned account-meta list — the variable
 * pass-through accounts that go into the warp `transfer_remote` fee section
 * for a given (destination domain, target router).
 *
 * The first returned meta is the fee account itself, followed by a payer
 * placeholder (Pubkey::default) that callers should replace with the real
 * payer before slotting the list into a transfer_remote instruction.
 */
export async function simulateFeeQuoteAccountMetas(args: {
  rpc: SvmRpc;
  programId: Address;
  feeAccount: Address;
  /** Funded address used as the simulation fee payer (signature not required). */
  payer: Address;
  input: GetQuoteAccountMetasInput;
}): Promise<SimulatedFeeAccountMeta[]> {
  const ix = getGetQuoteAccountMetasInstruction(
    args.programId,
    args.feeAccount,
    args.input,
  );

  const base = createTransactionMessage({ version: 0 });
  const withPayer = setTransactionMessageFeePayer(args.payer, base);
  const withLifetime = setTransactionMessageLifetimeUsingBlockhash(
    {
      blockhash: blockhash('11111111111111111111111111111111'),
      lastValidBlockHeight: 0n,
    },
    withPayer,
  );
  const withIx = appendTransactionMessageInstructions([ix], withLifetime);
  const compiled = compileTransactionMessage(withIx);
  const messageBytes = getCompiledTransactionMessageEncoder().encode(compiled);

  const sigCountBytes = getShortU16Encoder().encode(
    compiled.header.numSignerAccounts,
  );
  const sigsLen = compiled.header.numSignerAccounts * 64;
  const wireBytes = new Uint8Array(
    sigCountBytes.length + sigsLen + messageBytes.length,
  );
  wireBytes.set(sigCountBytes, 0);
  wireBytes.set(messageBytes, sigCountBytes.length + sigsLen);

  // CAST: branded type expects a signed wire tx but sigVerify=false accepts
  // the all-zero signature slots.
  const base64Tx = Buffer.from(wireBytes).toString(
    'base64',
  ) as Base64EncodedWireTransaction;

  const { value: result } = await args.rpc
    .simulateTransaction(base64Tx, {
      encoding: 'base64',
      commitment: 'confirmed',
      sigVerify: false,
      replaceRecentBlockhash: true,
      accounts: { encoding: 'base64', addresses: [] },
    })
    .send();

  if (result.err) {
    throw new Error(
      `simulateFeeQuoteAccountMetas failed: ${JSON.stringify(result.err)}`,
    );
  }

  const returnData = result.returnData?.data?.[0];
  assert(
    returnData,
    'simulateFeeQuoteAccountMetas: simulation returned no return_data',
  );

  return decodeSimulatedAccountMetas(Buffer.from(returnData, 'base64'));
}

/**
 * Decodes the Borsh `SimulationReturnData<Vec<SerializableAccountMeta>>`
 * wire format:
 *
 *   u32le length || N × (32 pubkey || bool isSigner || bool isWritable) || u8 trailing
 */
function decodeSimulatedAccountMetas(
  raw: Uint8Array,
): SimulatedFeeAccountMeta[] {
  const cursor = new ByteCursor(raw);
  const count = cursor.readU32LE();
  const metas: SimulatedFeeAccountMeta[] = [];
  for (let i = 0; i < count; i += 1) {
    metas.push({
      pubkey: readAddress(cursor),
      isSigner: cursor.readBool(),
      isWritable: cursor.readBool(),
    });
  }
  return metas;
}

// ====== SubmitQuote ======

/**
 * Builds the SubmitQuote instruction. The account list is caller-assembled
 * — typically by running `simulateSubmitQuoteAccountMetas`, replacing the
 * payer placeholder (index 1) with the real payer signer, and translating
 * the remaining sim metas to `InstructionAccountMeta`s.
 *
 * Wire layout consumed by the on-chain fee program:
 *   [0] system program
 *   [1] payer (signer + writable)
 *   [2] fee account (readonly)
 *   [3..N] route PDAs (readonly)
 *   [N+1] transient or standing quote PDA (writable)
 */
export function getSubmitQuoteInstruction(
  programAddress: Address,
  accounts: InstructionAccountMeta[],
  quote: SvmSignedQuote,
): Instruction {
  return buildInstruction(
    programAddress,
    accounts,
    concatBytes(
      u8(FeeInstructionKind.SubmitQuote),
      encodeSvmSignedQuote(quote),
    ),
  );
}

// ====== GetSubmitQuoteAccountMetas (simulation-only) ======

export interface GetSubmitQuoteAccountMetasInput {
  destinationDomain: number;
  /** Remote warp route contract address (H256, 32 bytes). */
  targetRouter: Uint8Array;
  /** When set, returns metas for a transient quote; otherwise standing. */
  scopedSalt?: Uint8Array;
}

export function encodeGetSubmitQuoteAccountMetasInput(
  input: GetSubmitQuoteAccountMetasInput,
): Uint8Array {
  assert(
    input.targetRouter.length === H256_LEN,
    `targetRouter must be ${H256_LEN} bytes`,
  );
  if (input.scopedSalt !== undefined) {
    assert(
      input.scopedSalt.length === SCOPED_SALT_LEN,
      `scopedSalt must be ${SCOPED_SALT_LEN} bytes`,
    );
  }
  return Uint8Array.from(
    concatBytes(
      u32le(input.destinationDomain),
      input.targetRouter,
      option(input.scopedSalt ?? null, (salt) => salt),
    ),
  );
}

export function getGetSubmitQuoteAccountMetasInstruction(
  programAddress: Address,
  feeAccount: Address,
  input: GetSubmitQuoteAccountMetasInput,
): Instruction {
  return buildInstruction(
    programAddress,
    [readonlyAccount(feeAccount)],
    concatBytes(
      u8(FeeInstructionKind.GetSubmitQuoteAccountMetas),
      encodeGetSubmitQuoteAccountMetasInput(input),
    ),
  );
}

/**
 * Runs `GetSubmitQuoteAccountMetas` via simulation and parses the returned
 * account-meta list — the accounts the caller must pass to a matching
 * `SubmitQuote` instruction. The returned list has a payer placeholder at
 * index 1 that callers must replace with the real payer pubkey.
 */
export async function simulateSubmitQuoteAccountMetas(args: {
  rpc: SvmRpc;
  programId: Address;
  feeAccount: Address;
  /** Funded address used as the simulation fee payer (signature not required). */
  payer: Address;
  input: GetSubmitQuoteAccountMetasInput;
}): Promise<SimulatedFeeAccountMeta[]> {
  const ix = getGetSubmitQuoteAccountMetasInstruction(
    args.programId,
    args.feeAccount,
    args.input,
  );

  const base = createTransactionMessage({ version: 0 });
  const withPayer = setTransactionMessageFeePayer(args.payer, base);
  const withLifetime = setTransactionMessageLifetimeUsingBlockhash(
    {
      blockhash: blockhash('11111111111111111111111111111111'),
      lastValidBlockHeight: 0n,
    },
    withPayer,
  );
  const withIx = appendTransactionMessageInstructions([ix], withLifetime);
  const compiled = compileTransactionMessage(withIx);
  const messageBytes = getCompiledTransactionMessageEncoder().encode(compiled);

  const sigCountBytes = getShortU16Encoder().encode(
    compiled.header.numSignerAccounts,
  );
  const sigsLen = compiled.header.numSignerAccounts * 64;
  const wireBytes = new Uint8Array(
    sigCountBytes.length + sigsLen + messageBytes.length,
  );
  wireBytes.set(sigCountBytes, 0);
  wireBytes.set(messageBytes, sigCountBytes.length + sigsLen);

  // CAST: branded type expects a signed wire tx but sigVerify=false accepts
  // the all-zero signature slots.
  const base64Tx = Buffer.from(wireBytes).toString(
    'base64',
  ) as Base64EncodedWireTransaction;

  const { value: result } = await args.rpc
    .simulateTransaction(base64Tx, {
      encoding: 'base64',
      commitment: 'confirmed',
      sigVerify: false,
      replaceRecentBlockhash: true,
      accounts: { encoding: 'base64', addresses: [] },
    })
    .send();

  if (result.err) {
    throw new Error(
      `simulateSubmitQuoteAccountMetas failed: ${JSON.stringify(result.err)}`,
    );
  }

  const returnData = result.returnData?.data?.[0];
  assert(
    returnData,
    'simulateSubmitQuoteAccountMetas: simulation returned no return_data',
  );

  return decodeSimulatedAccountMetas(Buffer.from(returnData, 'base64'));
}
