import type { Address, Instruction } from '@solana/kit';

import { assert } from '@hyperlane-xyz/utils';

import { u64le } from '../codecs/binary.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  SPL_TOKEN_PROGRAM_ADDRESS,
  SYSTEM_PROGRAM_ADDRESS,
} from '../constants.js';

import {
  buildInstruction,
  readonlyAccount,
  writableAccount,
  writableSignerAddress,
  readonlySignerAddress,
} from './utils.js';

/** Associated Token program instruction discriminants. */
const AssociatedTokenInstructionKind = {
  CreateIdempotent: 1,
} as const;

/** SPL Token program instruction discriminants. */
const SplTokenInstructionKind = {
  MintTo: 7,
} as const;

/**
 * Builds the idempotent CreateAssociatedTokenAccount instruction (kind 1).
 *
 * Succeeds even when the ATA already exists, so callers can fearlessly
 * issue it whether or not the account was previously initialized.
 *
 * Accounts: `[payer(w,s), ata(w), wallet, mint, system, token_program]`.
 */
export function getCreateAssociatedTokenIdempotentInstruction(args: {
  payer: Address;
  ata: Address;
  wallet: Address;
  mint: Address;
  /** Defaults to the classic SPL Token program. Pass Token-2022 for Token-2022 mints. */
  tokenProgram?: Address;
}): Instruction {
  return buildInstruction(
    ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
    [
      writableSignerAddress(args.payer),
      writableAccount(args.ata),
      readonlyAccount(args.wallet),
      readonlyAccount(args.mint),
      readonlyAccount(SYSTEM_PROGRAM_ADDRESS),
      readonlyAccount(args.tokenProgram ?? SPL_TOKEN_PROGRAM_ADDRESS),
    ],
    new Uint8Array([AssociatedTokenInstructionKind.CreateIdempotent]),
  );
}

/**
 * Builds the SPL Token v2 MintTo instruction (discriminator 7).
 *
 * Data layout: `[u8(7), u64 LE amount]` (9 bytes).
 * Accounts: `[mint(w), destination(w), authority(s)]`.
 */
const U64_MAX = (1n << 64n) - 1n;

export function getMintToInstruction(args: {
  mint: Address;
  destination: Address;
  authority: Address;
  amount: bigint;
  /** Defaults to the classic SPL Token program. */
  tokenProgram?: Address;
}): Instruction {
  assert(
    args.amount >= 0n && args.amount <= U64_MAX,
    `getMintToInstruction: amount ${args.amount} does not fit in u64 (0..${U64_MAX})`,
  );
  const data = new Uint8Array([
    SplTokenInstructionKind.MintTo,
    ...u64le(args.amount),
  ]);
  return buildInstruction(
    args.tokenProgram ?? SPL_TOKEN_PROGRAM_ADDRESS,
    [
      writableAccount(args.mint),
      writableAccount(args.destination),
      readonlySignerAddress(args.authority),
    ],
    data,
  );
}
