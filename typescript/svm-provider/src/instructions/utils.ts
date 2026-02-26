import { AccountRole } from '@solana/kit';
import type {
  AccountMeta,
  AccountSignerMeta,
  Address,
  Instruction,
  ReadonlyUint8Array,
  TransactionSigner,
} from '@solana/kit';

export type InstructionAccountMeta = AccountMeta | AccountSignerMeta;

export function readonlyAccount(address: Address): InstructionAccountMeta {
  return { address, role: AccountRole.READONLY };
}

export function writableAccount(address: Address): InstructionAccountMeta {
  return { address, role: AccountRole.WRITABLE };
}

export function readonlySigner(
  signer: TransactionSigner,
): InstructionAccountMeta {
  return { address: signer.address, role: AccountRole.READONLY_SIGNER, signer };
}

/**
 * Marks an address as a required readonly signer without embedding a keypair.
 * Use this for update instructions where signing is deferred to the caller.
 */
export function readonlySignerAddress(
  address: Address,
): InstructionAccountMeta {
  return { address, role: AccountRole.READONLY_SIGNER };
}

/**
 * Marks an address as a required writable signer without embedding a keypair.
 * Use this when the account must both sign and be mutated, but the keypair is
 * managed by the caller (e.g. the transaction payer for a SOL transfer).
 */
export function writableSignerAddress(
  address: Address,
): InstructionAccountMeta {
  return { address, role: AccountRole.WRITABLE_SIGNER };
}

export function writableSigner(
  signer: TransactionSigner,
): InstructionAccountMeta {
  return { address: signer.address, role: AccountRole.WRITABLE_SIGNER, signer };
}

export function buildInstruction(
  programAddress: Address,
  accounts: InstructionAccountMeta[],
  data: ReadonlyUint8Array,
): Instruction {
  return {
    programAddress,
    accounts: accounts as AccountMeta[],
    data,
  };
}
