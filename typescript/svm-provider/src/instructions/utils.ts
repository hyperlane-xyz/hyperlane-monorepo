import { AccountRole } from '@solana/kit';
import type {
  AccountMeta,
  AccountSignerMeta,
  Address,
  Instruction,
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

export function writableSigner(
  signer: TransactionSigner,
): InstructionAccountMeta {
  return { address: signer.address, role: AccountRole.WRITABLE_SIGNER, signer };
}

export function buildInstruction(
  programAddress: Address,
  accounts: InstructionAccountMeta[],
  data: Uint8Array,
): Instruction {
  return {
    programAddress,
    accounts: accounts as AccountMeta[],
    data,
  };
}
