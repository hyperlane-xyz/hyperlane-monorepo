import {
  AccountMeta,
  Connection,
  Message,
  PublicKey,
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
  return returnData.readBigUInt64LE(0);
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
