import { PublicKey } from '@solana/web3.js';

import { BaseSealevelAdapter } from '../../app/MultiProtocolApp.js';
import { SealevelInstructionWrapper } from '../../utils/sealevelSerialization.js';

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
