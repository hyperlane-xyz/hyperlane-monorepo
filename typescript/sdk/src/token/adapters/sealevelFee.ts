import {
  AccountMeta,
  Connection,
  Message,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  VersionedTransaction,
} from '@solana/web3.js';
import { deserializeUnchecked, serialize } from 'borsh';

import { assert } from '@hyperlane-xyz/utils';

import { BaseSealevelAdapter } from '../../app/MultiProtocolApp.js';
import {
  SealevelGetIgpQuoteAccountMetasInstruction,
  SealevelGetIgpQuoteAccountMetasSchema,
  SealevelIgpInstruction,
  SealevelIgpQuoteGasPaymentInstruction,
  SealevelIgpQuoteGasPaymentResponse,
  SealevelIgpQuoteGasPaymentResponseSchema,
  SealevelIgpQuoteGasPaymentSchema,
} from '../../gas/adapters/serialization.js';
import {
  SealevelAccountDataWrapper,
  SealevelInstructionWrapper,
} from '../../utils/sealevelSerialization.js';

// ============================================================================
// Fee program instructions
// ============================================================================

// Should match Instruction in
// rust/sealevel/programs/hyperlane-sealevel-fee/src/instruction.rs.
export enum SealevelFeeInstruction {
  InitFee,
  QuoteFee,
  SetRemoteFeeRoute,
  RemoveRemoteFeeRoute,
  UpdateFeeParams,
  SetBeneficiary,
  TransferOwnership,
  SetQuoteSigner,
  SetMinIssuedAt,
  SetWildcardQuoteSigners,
  SubmitQuote,
  CloseTransientQuote,
  PruneExpiredQuotes,
  GetQuoteAccountMetas,
  GetSubmitQuoteAccountMetas,
}

/// QuoteFee instruction data. CPI'd from the warp program during a
/// transfer_remote when the token's fee_config is set; the fee program
/// returns the fee amount as u64 LE via set_return_data.
export class SealevelQuoteFeeInstruction {
  destination_domain!: number;
  recipient!: Uint8Array; // 32 bytes (H256)
  amount!: bigint;
  target_router!: Uint8Array; // 32 bytes (H256)

  constructor(fields: any) {
    Object.assign(this, fields);
  }
}

export const SealevelQuoteFeeSchema = new Map<any, any>([
  [
    SealevelInstructionWrapper,
    {
      kind: 'struct',
      fields: [
        ['instruction', 'u8'],
        ['data', SealevelQuoteFeeInstruction],
      ],
    },
  ],
  [
    SealevelQuoteFeeInstruction,
    {
      kind: 'struct',
      fields: [
        ['destination_domain', 'u32'],
        ['recipient', [32]],
        ['amount', 'u64'],
        ['target_router', [32]],
      ],
    },
  ],
]);

/// Simulation-only instruction returning the variable pass-through account
/// metas required for a QuoteFee call. The first slot in the returned vector
/// is the fee account; the last is the fee beneficiary. Standing-cascade
/// callers pass scoped_salt = null.
export class SealevelGetQuoteAccountMetasInstruction {
  destination_domain!: number;
  target_router!: Uint8Array; // 32 bytes
  scoped_salt!: Uint8Array | null; // 32 bytes if Some, null = standing only

  constructor(fields: any) {
    Object.assign(this, fields);
  }
}

export const SealevelGetQuoteAccountMetasSchema = new Map<any, any>([
  [
    SealevelInstructionWrapper,
    {
      kind: 'struct',
      fields: [
        ['instruction', 'u8'],
        ['data', SealevelGetQuoteAccountMetasInstruction],
      ],
    },
  ],
  [
    SealevelGetQuoteAccountMetasInstruction,
    {
      kind: 'struct',
      fields: [
        ['destination_domain', 'u32'],
        ['target_router', [32]],
        ['scoped_salt', { kind: 'option', type: [32] }],
      ],
    },
  ],
]);

// ============================================================================
// PDA helpers
// ============================================================================

const FEE_PROGRAM_SEED = Buffer.from('hyperlane_fee');
const IGP_PROGRAM_SEED = Buffer.from('hyperlane_igp');
const SEP = Buffer.from('-');
const FEE_SEG = Buffer.from('fee');
const STANDING_SEG = Buffer.from('standing');
const STANDING_QUOTE_SEG = Buffer.from('standing_quote');
const H256_ZERO = Buffer.alloc(32, 0);

function u32LeBuf(value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value, 0);
  return buf;
}

/**
 * Derive a fee account PDA. Seeds:
 * ["hyperlane_fee", "-", "fee", "-", salt].
 * Matches `fee_account_pda_seeds` in
 * rust/sealevel/programs/hyperlane-sealevel-fee/src/pda_seeds.rs.
 */
export function deriveFeeAccountPda(
  programId: PublicKey,
  salt: Uint8Array,
): PublicKey {
  return BaseSealevelAdapter.derivePda(
    [FEE_PROGRAM_SEED, SEP, FEE_SEG, SEP, Buffer.from(salt)],
    programId,
  );
}

/**
 * Derive a fee standing quote PDA. Seeds:
 * ["hyperlane_fee", "-", "standing", "-", fee_account, "-", domain_le, "-", target_router].
 *
 * For Leaf/Routing modes pass `targetRouter = null`; the helper substitutes
 * the H256::zero() sentinel per the on-chain seed macro. For CrossCollateral
 * routing pass the actual remote router H256.
 */
export function deriveFeeStandingQuotePda(
  programId: PublicKey,
  feeAccount: PublicKey,
  destinationDomain: number,
  targetRouter: Uint8Array | null,
): PublicKey {
  const target = targetRouter ? Buffer.from(targetRouter) : H256_ZERO;
  return BaseSealevelAdapter.derivePda(
    [
      FEE_PROGRAM_SEED,
      SEP,
      STANDING_SEG,
      SEP,
      feeAccount.toBuffer(),
      SEP,
      u32LeBuf(destinationDomain),
      SEP,
      target,
    ],
    programId,
  );
}

/**
 * Derive an IGP standing quote PDA. Seeds:
 * ["hyperlane_igp", "-", "standing_quote", "-", igp_account, "-",
 *  fee_token_mint, "-", dest_domain_le, "-", sender].
 *
 * Use Pubkey::default() (= SystemProgram.programId on the JS side, both are
 * the all-zero pubkey) for SOL-paying routes. The sender is the warp route
 * program ID.
 */
export function deriveIgpStandingQuotePda(
  programId: PublicKey,
  igpAccount: PublicKey,
  feeTokenMint: PublicKey,
  destinationDomain: number,
  sender: PublicKey,
): PublicKey {
  return BaseSealevelAdapter.derivePda(
    [
      IGP_PROGRAM_SEED,
      SEP,
      STANDING_QUOTE_SEG,
      SEP,
      igpAccount.toBuffer(),
      SEP,
      feeTokenMint.toBuffer(),
      SEP,
      u32LeBuf(destinationDomain),
      SEP,
      sender.toBuffer(),
    ],
    programId,
  );
}

// ============================================================================
// Simulation helpers
// ============================================================================

// SerializableAccountMeta = [pubkey: 32, is_signer: u8, is_writable: u8] = 34
// bytes. Matches serializable_account_meta::SerializableAccountMeta in the
// Rust workspace.
const SERIALIZABLE_ACCOUNT_META_SIZE = 34;

/**
 * Parse a borsh-encoded `Vec<SerializableAccountMeta>` (u32 LE length prefix
 * + N * 34 bytes) into the @solana/web3.js AccountMeta shape.
 */
export function parseSimulationAccountMetas(data: Buffer): AccountMeta[] {
  assert(
    data.length >= 4,
    `Simulation return data too short for length prefix: ${data.length}`,
  );
  const count = data.readUInt32LE(0);
  const expectedLength = 4 + count * SERIALIZABLE_ACCOUNT_META_SIZE;
  assert(
    data.length >= expectedLength,
    `Truncated Vec<SerializableAccountMeta>: expected ${expectedLength}, got ${data.length}`,
  );
  const metas: AccountMeta[] = [];
  for (let i = 0; i < count; i++) {
    const off = 4 + i * SERIALIZABLE_ACCOUNT_META_SIZE;
    metas.push({
      pubkey: new PublicKey(data.subarray(off, off + 32)),
      isSigner: data[off + 32] !== 0,
      isWritable: data[off + 33] !== 0,
    });
  }
  return metas;
}

async function simulateAndReadReturnData(
  connection: Connection,
  ix: TransactionInstruction,
  payer: PublicKey,
  label: string,
): Promise<Buffer> {
  const message = Message.compile({
    recentBlockhash: PublicKey.default.toBase58(),
    instructions: [ix],
    payerKey: payer,
  });
  const sim = await connection.simulateTransaction(
    new VersionedTransaction(message),
    {
      replaceRecentBlockhash: true,
      sigVerify: false,
    },
  );
  assert(
    !sim.value.err,
    `${label} simulation failed: ${JSON.stringify(sim.value.err)}\nLogs: ${sim.value.logs?.join('\n')}`,
  );
  const base64 = sim.value.returnData?.data?.[0];
  assert(base64, `${label} simulation returned no data`);
  return Buffer.from(base64, 'base64');
}

/**
 * Simulation-only: returns the account metas required for a `QuoteFee` call
 * on the fee program. Slot 0 of the returned vector is the fee account,
 * slot 1 is a payer placeholder (Pubkey::default()) that callers must
 * substitute with the real payer before passing into `simulateWarpFee` or a
 * `transfer_remote` instruction.
 */
export async function simulateFeeQuoteAccountMetas(
  connection: Connection,
  feeProgram: PublicKey,
  feeAccount: PublicKey,
  payer: PublicKey,
  params: {
    destinationDomain: number;
    targetRouter: Uint8Array;
    scopedSalt?: Uint8Array;
  },
): Promise<AccountMeta[]> {
  const wrapped = new SealevelInstructionWrapper({
    instruction: SealevelFeeInstruction.GetQuoteAccountMetas,
    data: new SealevelGetQuoteAccountMetasInstruction({
      destination_domain: params.destinationDomain,
      target_router: params.targetRouter,
      scoped_salt: params.scopedSalt ?? null,
    }),
  });
  const ix = new TransactionInstruction({
    keys: [{ pubkey: feeAccount, isSigner: false, isWritable: false }],
    programId: feeProgram,
    data: Buffer.from(serialize(SealevelGetQuoteAccountMetasSchema, wrapped)),
  });
  const returnData = await simulateAndReadReturnData(
    connection,
    ix,
    payer,
    'GetQuoteAccountMetas',
  );
  return parseSimulationAccountMetas(returnData);
}

/**
 * Simulation-only: returns the account metas required for a `QuoteGasPayment`
 * call in the new-flow IGP path. The returned vector starts with system
 * program, payer placeholder, program_data, unique_gas_payment placeholder,
 * gas_payment_pda placeholder, IGP account, then the cascade PDAs. Callers
 * must substitute placeholders before passing accounts into a real call.
 */
export async function simulateIgpQuoteAccountMetas(
  connection: Connection,
  igpProgram: PublicKey,
  igpAccount: PublicKey,
  payer: PublicKey,
  params: {
    destinationDomain: number;
    sender: PublicKey;
    scopedSalt?: Uint8Array;
  },
): Promise<AccountMeta[]> {
  const wrapped = new SealevelInstructionWrapper({
    instruction: SealevelIgpInstruction.GetIgpQuoteAccountMetas,
    data: new SealevelGetIgpQuoteAccountMetasInstruction({
      destination_domain: params.destinationDomain,
      sender: params.sender.toBytes(),
      scoped_salt: params.scopedSalt ?? null,
    }),
  });
  const ix = new TransactionInstruction({
    keys: [{ pubkey: igpAccount, isSigner: false, isWritable: false }],
    programId: igpProgram,
    data: Buffer.from(
      serialize(SealevelGetIgpQuoteAccountMetasSchema, wrapped),
    ),
  });
  const returnData = await simulateAndReadReturnData(
    connection,
    ix,
    payer,
    'GetIgpQuoteAccountMetas',
  );
  return parseSimulationAccountMetas(returnData);
}

/**
 * Simulation-only: invokes `QuoteFee` on the fee program with the provided
 * account list and returns the u64 LE fee amount via return data. The
 * accounts must mirror the layout from `simulateFeeQuoteAccountMetas` with
 * the payer placeholder (slot 1) replaced by the real payer.
 */
export async function simulateWarpFee(
  connection: Connection,
  feeProgram: PublicKey,
  payer: PublicKey,
  accounts: AccountMeta[],
  params: {
    destinationDomain: number;
    recipient: Uint8Array;
    amount: bigint;
    targetRouter: Uint8Array;
  },
): Promise<bigint> {
  const wrapped = new SealevelInstructionWrapper({
    instruction: SealevelFeeInstruction.QuoteFee,
    data: new SealevelQuoteFeeInstruction({
      destination_domain: params.destinationDomain,
      recipient: params.recipient,
      amount: params.amount,
      target_router: params.targetRouter,
    }),
  });
  const ix = new TransactionInstruction({
    keys: accounts,
    programId: feeProgram,
    data: Buffer.from(serialize(SealevelQuoteFeeSchema, wrapped)),
  });
  const returnData = await simulateAndReadReturnData(
    connection,
    ix,
    payer,
    'QuoteFee',
  );
  assert(
    returnData.length >= 8,
    `QuoteFee return data truncated: expected u64 LE, got ${returnData.length} bytes`,
  );
  return new DataView(
    returnData.buffer,
    returnData.byteOffset,
    returnData.byteLength,
  ).getBigUint64(0, true);
}

/**
 * Simulation-only: invokes the IGP's `QuoteGasPayment` with the provided
 * account list (legacy or new-flow) and returns the u64 quote amount.
 */
export async function simulateIgpQuote(
  connection: Connection,
  igpProgram: PublicKey,
  payer: PublicKey,
  accounts: AccountMeta[],
  params: {
    destinationDomain: number;
    gasAmount: bigint;
  },
): Promise<bigint> {
  const wrapped = new SealevelInstructionWrapper({
    instruction: SealevelIgpInstruction.QuoteGasPayment,
    data: new SealevelIgpQuoteGasPaymentInstruction({
      destination_domain: params.destinationDomain,
      gas_amount: params.gasAmount,
    }),
  });
  const ix = new TransactionInstruction({
    keys: accounts,
    programId: igpProgram,
    data: Buffer.from(serialize(SealevelIgpQuoteGasPaymentSchema, wrapped)),
  });
  const returnData = await simulateAndReadReturnData(
    connection,
    ix,
    payer,
    'QuoteGasPayment',
  );
  const quote = deserializeUnchecked(
    SealevelIgpQuoteGasPaymentResponseSchema,
    SealevelAccountDataWrapper,
    returnData,
  );
  const data = quote.data;
  assert(
    data instanceof SealevelIgpQuoteGasPaymentResponse,
    'Decoded QuoteGasPayment response is not SealevelIgpQuoteGasPaymentResponse',
  );
  return data.payment_quote;
}

// ============================================================================
// SubmitQuote: Borsh schemas
// ============================================================================
//
// Wire form of `SvmSignedQuote` (Rust `quote-verifier::SvmSignedQuote`):
//   context:    Vec<u8>  (u32 LE len + bytes)  — 44B non-CC, 76B CC
//   data:       Vec<u8>  (u32 LE len + bytes)  — Borsh-encoded FeeDataStrategy
//   issuedAt:   [u8; 6]                        — u48 BE unix seconds
//   expiry:     [u8; 6]                        — u48 BE unix seconds
//   clientSalt: [u8; 32]
//   signature:  [u8; 65]
//
// Submitted on-chain as `SubmitQuote(SvmSignedQuote)` (fee program, disc 10)
// or `SubmitIgpQuote(SvmSignedQuote)` (IGP program, disc 14). The borsh
// schema is the same data class — only the wrapper's `instruction` value
// differs at runtime.

/**
 * Wire form of `SvmSignedQuote`. Mirrors svm-sdk's `SvmSignedQuote` codec
 * (`@solana/kit` based) but built on the borsh-style schemas the SDK already
 * uses for SVM ix encoding.
 */
export class SealevelSvmSignedQuote {
  context!: Uint8Array;
  data!: Uint8Array;
  issued_at!: Uint8Array; // 6
  expiry!: Uint8Array; // 6
  client_salt!: Uint8Array; // 32
  signature!: Uint8Array; // 65

  constructor(fields: any) {
    Object.assign(this, fields);
  }
}

/**
 * Schema for either `SubmitQuote` (fee) or `SubmitIgpQuote` (IGP). Caller
 * sets the wrapper's `instruction` discriminator at construction.
 */
export const SealevelSubmitQuoteSchema = new Map<any, any>([
  [
    SealevelInstructionWrapper,
    {
      kind: 'struct',
      fields: [
        ['instruction', 'u8'],
        ['data', SealevelSvmSignedQuote],
      ],
    },
  ],
  [
    SealevelSvmSignedQuote,
    {
      kind: 'struct',
      fields: [
        ['context', ['u8']],
        ['data', ['u8']],
        ['issued_at', [6]],
        ['expiry', [6]],
        ['client_salt', [32]],
        ['signature', [65]],
      ],
    },
  ],
]);

/**
 * `GetSubmitQuoteAccountMetas` data — simulation-only request returning the
 * variable account list the fee program needs to consume a quote. Mirrors
 * the on-chain instruction by the same name (fee program, disc 14).
 */
export class SealevelGetSubmitQuoteAccountMetasInstruction {
  destination_domain!: number;
  target_router!: Uint8Array; // 32
  scoped_salt!: Uint8Array | null; // 32 if Some; null ⇒ standing-only request

  constructor(fields: any) {
    Object.assign(this, fields);
  }
}

export const SealevelGetSubmitQuoteAccountMetasSchema = new Map<any, any>([
  [
    SealevelInstructionWrapper,
    {
      kind: 'struct',
      fields: [
        ['instruction', 'u8'],
        ['data', SealevelGetSubmitQuoteAccountMetasInstruction],
      ],
    },
  ],
  [
    SealevelGetSubmitQuoteAccountMetasInstruction,
    {
      kind: 'struct',
      fields: [
        ['destination_domain', 'u32'],
        ['target_router', [32]],
        ['scoped_salt', { kind: 'option', type: [32] }],
      ],
    },
  ],
]);

// ============================================================================
// IGP transient quote PDA
// ============================================================================

const TRANSIENT_QUOTE_SEG = Buffer.from('transient_quote');

/**
 * Derive an IGP transient-quote PDA. Seeds:
 * ["hyperlane_igp", "-", "transient_quote", "-", igp_account, "-", scoped_salt].
 *
 * Mirrors svm-sdk's `deriveIgpTransientQuotePda` — the on-chain PDA the IGP
 * `SubmitIgpQuote` handler initializes for a transient (one-shot) quote.
 */
export function deriveIgpTransientQuotePda(
  programId: PublicKey,
  igpAccount: PublicKey,
  scopedSalt: Uint8Array,
): PublicKey {
  assert(
    scopedSalt.length === 32,
    `scopedSalt must be 32 bytes, got ${scopedSalt.length}`,
  );
  return BaseSealevelAdapter.derivePda(
    [
      IGP_PROGRAM_SEED,
      SEP,
      TRANSIENT_QUOTE_SEG,
      SEP,
      igpAccount.toBuffer(),
      SEP,
      Buffer.from(scopedSalt),
    ],
    programId,
  );
}

// ============================================================================
// SubmitFeeQuote (warp fee program)
// ============================================================================

/**
 * Account-meta layout returned from `GetSubmitQuoteAccountMetas`:
 *   [0] system program (readonly)
 *   [1] payer placeholder (Pubkey::default — substituted before submit)
 *   [2] fee account (readonly)
 *   [3..N] route PDAs (readonly cascade)
 *   [N+1] transient or standing quote PDA (writable)
 *
 * `simulateSubmitFeeQuoteAccountMetas` runs the simulation, asserts the
 * placeholder is at slot 1 (drift in the on-chain layout fails loudly here
 * rather than at submit), and substitutes the real payer (writable signer).
 */
export async function simulateSubmitFeeQuoteAccountMetas(
  connection: Connection,
  feeProgram: PublicKey,
  feeAccount: PublicKey,
  payer: PublicKey,
  params: {
    destinationDomain: number;
    targetRouter: Uint8Array;
    scopedSalt?: Uint8Array;
  },
): Promise<AccountMeta[]> {
  const wrapped = new SealevelInstructionWrapper({
    instruction: SealevelFeeInstruction.GetSubmitQuoteAccountMetas,
    data: new SealevelGetSubmitQuoteAccountMetasInstruction({
      destination_domain: params.destinationDomain,
      target_router: params.targetRouter,
      scoped_salt: params.scopedSalt ?? null,
    }),
  });
  const ix = new TransactionInstruction({
    keys: [{ pubkey: feeAccount, isSigner: false, isWritable: false }],
    programId: feeProgram,
    data: Buffer.from(
      serialize(SealevelGetSubmitQuoteAccountMetasSchema, wrapped),
    ),
  });
  const returnData = await simulateAndReadReturnData(
    connection,
    ix,
    payer,
    'GetSubmitQuoteAccountMetas',
  );
  const metas = parseSimulationAccountMetas(returnData);

  assert(
    metas[1]?.pubkey.equals(PublicKey.default),
    `simulateSubmitFeeQuoteAccountMetas: expected payer placeholder (${PublicKey.default.toBase58()}) at slot 1, got ${metas[1]?.pubkey.toBase58()} — on-chain contract may have changed`,
  );
  return metas.map((m, i) =>
    i === 1 ? { pubkey: payer, isSigner: true, isWritable: true } : m,
  );
}

/**
 * Build a `SubmitQuote` instruction for the warp fee program. Account list
 * is discovered via `simulateSubmitFeeQuoteAccountMetas` and includes the
 * resolved cascade PDA(s) the on-chain handler will read/write.
 */
export async function buildSubmitFeeQuoteIx(args: {
  connection: Connection;
  feeProgramId: PublicKey;
  feeAccount: PublicKey;
  payer: PublicKey;
  signedQuote: SealevelSvmSignedQuote;
  /** Required for transient mode (when `signedQuote.expiry === signedQuote.issued_at`). */
  scopedSalt?: Uint8Array;
  /** Hyperlane destination domain ID. */
  destinationDomain: number;
  /** 32-byte remote warp router (H256). */
  targetRouter: Uint8Array;
}): Promise<TransactionInstruction> {
  const accounts = await simulateSubmitFeeQuoteAccountMetas(
    args.connection,
    args.feeProgramId,
    args.feeAccount,
    args.payer,
    {
      destinationDomain: args.destinationDomain,
      targetRouter: args.targetRouter,
      scopedSalt: args.scopedSalt,
    },
  );

  const wrapped = new SealevelInstructionWrapper({
    instruction: SealevelFeeInstruction.SubmitQuote,
    data: args.signedQuote,
  });
  return new TransactionInstruction({
    keys: accounts,
    programId: args.feeProgramId,
    data: Buffer.from(serialize(SealevelSubmitQuoteSchema, wrapped)),
  });
}

// ============================================================================
// SubmitIgpQuote (IGP program)
// ============================================================================

/**
 * Build a `SubmitIgpQuote` instruction for the IGP program. Unlike the fee
 * variant, the IGP submit has a fixed 4-account layout and the caller is
 * responsible for deriving the destination quote PDA (transient or standing).
 *
 * Wire layout:
 *   [0] system program (readonly)
 *   [1] payer (writable signer)
 *   [2] igp account (readonly)
 *   [3] quote PDA (writable)
 */
export function buildSubmitIgpQuoteIx(args: {
  igpProgramId: PublicKey;
  igpAccount: PublicKey;
  payer: PublicKey;
  /**
   * Pre-derived destination PDA:
   *  - Transient: `deriveIgpTransientQuotePda(programId, igpAccount, scopedSalt)`
   *  - Standing:  `deriveIgpStandingQuotePda(programId, igpAccount, feeTokenMint, destDomain, sender)`
   */
  quotePda: PublicKey;
  signedQuote: SealevelSvmSignedQuote;
}): TransactionInstruction {
  const wrapped = new SealevelInstructionWrapper({
    instruction: SealevelIgpInstruction.SubmitIgpQuote,
    data: args.signedQuote,
  });
  return new TransactionInstruction({
    keys: [
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: args.payer, isSigner: true, isWritable: true },
      { pubkey: args.igpAccount, isSigner: false, isWritable: false },
      { pubkey: args.quotePda, isSigner: false, isWritable: true },
    ],
    programId: args.igpProgramId,
    data: Buffer.from(serialize(SealevelSubmitQuoteSchema, wrapped)),
  });
}
