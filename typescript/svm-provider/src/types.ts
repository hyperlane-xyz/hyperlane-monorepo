import type { Address, Instruction, Signature } from '@solana/kit';

import type { Annotated } from '@hyperlane-xyz/utils';

/**
 * Core SVM instruction type alias.
 */
export type SvmInstruction = Instruction;

/**
 * SVM transaction representing a set of instructions to be executed.
 */
export interface SvmTransaction {
  instructions: SvmInstruction[];
  computeUnits?: number;
}

/**
 * Transaction receipt after successful execution.
 */
export interface SvmReceipt {
  signature: Signature;
  slot: bigint;
}

/**
 * SVM transaction with optional annotation for display purposes.
 */
export type AnnotatedSvmTransaction = Annotated<SvmTransaction>;

/**
 * Program addresses for core Hyperlane SVM programs.
 * On Solana, "address" refers to the program ID.
 * State lives in PDAs derived from program IDs.
 */
export interface SvmProgramAddresses {
  mailbox: Address;
  igp: Address;
  multisigIsm: Address;
  testIsm: Address;
  validatorAnnounce?: Address;
}

/**
 * RPC type alias for Solana RPC client.
 * Uses the pattern from generated Codama files: Parameters<typeof fetchEncodedAccount>[0]
 */
export type SvmRpc = Parameters<
  typeof import('@solana/kit').fetchEncodedAccount
>[0];
