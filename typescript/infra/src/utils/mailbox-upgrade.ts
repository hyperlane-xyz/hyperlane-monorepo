import { writeFileSync } from 'fs';

import { AccountRole } from '@solana/kit';
import { PublicKey } from '@solana/web3.js';

import { assert, eqAddressSol } from '@hyperlane-xyz/utils';
import { ensureDirectoryExists } from '@hyperlane-xyz/utils/fs';

import {
  type PrintableSvmInstruction,
  type PrintableSvmTransaction,
  ReceiptFileSchema,
  validateInstructionsAgainstWire,
} from './warp-propose-squads.js';

const CLOCK_SYSVAR = 'SysvarC1ock11111111111111111111111111111111';
export const LOADER_V3 = 'BPFLoaderUpgradeab1e11111111111111111111111';
export const MAX_COMPUTE_UNITS = 1_400_000;
const PROGRAM_DATA_HEADER_SIZE = 45;
const RENT_SYSVAR = 'SysvarRent111111111111111111111111111111111';
const UPGRADE_DATA = '03000000';

type ExpectedAccount = {
  address: string | null;
  role: AccountRole;
};

export function reserveMailboxUpgradeOutput(
  outputPath: string,
  reservation: object,
): void {
  ensureDirectoryExists(outputPath);
  try {
    writeFileSync(outputPath, `${JSON.stringify(reservation, null, 2)}\n`, {
      flag: 'wx',
    });
  } catch (error: unknown) {
    throw new Error(
      `Unable to reserve output path ${outputPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function deriveProgramDataAddress(program: string): string {
  const [programData] = PublicKey.findProgramAddressSync(
    [new PublicKey(program).toBuffer()],
    new PublicKey(LOADER_V3),
  );
  return programData.toBase58();
}

export function assertProgramBinaryFitsCurrentCapacity({
  programBinarySize,
  programDataAccountSize,
}: {
  programBinarySize: number;
  programDataAccountSize: number;
}): number {
  assert(
    programDataAccountSize >= PROGRAM_DATA_HEADER_SIZE,
    `Invalid ProgramData account size ${programDataAccountSize}`,
  );
  const currentCapacity = programDataAccountSize - PROGRAM_DATA_HEADER_SIZE;
  assert(
    programBinarySize <= currentCapacity,
    `Single-transaction mailbox upgrade requires the ${programBinarySize}-byte binary to fit the current ${currentCapacity}-byte ProgramData capacity; an Extend transaction is required`,
  );
  return currentCapacity;
}

/**
 * Validates the loader Upgrade shape, known account identities, and every
 * account role. Buffer contents must be verified independently on chain.
 */
export function assertMailboxUpgradeInstruction({
  instruction,
  mailbox,
  upgradeAuthority,
  spillAddress,
}: {
  instruction: PrintableSvmInstruction;
  mailbox: string;
  upgradeAuthority: string;
  spillAddress: string;
}): void {
  assert(
    eqAddressSol(instruction.programAddress, LOADER_V3),
    `Expected loader-v3 instruction, got ${instruction.programAddress}`,
  );
  assert(
    instruction.data === UPGRADE_DATA,
    `Expected loader Upgrade data ${UPGRADE_DATA}, got ${instruction.data ?? 'none'}`,
  );
  assert(
    instruction.accounts?.length === 7,
    `Expected loader Upgrade to have 7 accounts, got ${instruction.accounts?.length ?? 0}`,
  );

  const expectedAccounts: ExpectedAccount[] = [
    {
      address: deriveProgramDataAddress(mailbox),
      role: AccountRole.WRITABLE,
    },
    { address: mailbox, role: AccountRole.WRITABLE },
    // Buffer identity comes from the receipt; the simulator verifies its bytes.
    { address: null, role: AccountRole.WRITABLE },
    { address: spillAddress, role: AccountRole.WRITABLE },
    { address: RENT_SYSVAR, role: AccountRole.READONLY },
    { address: CLOCK_SYSVAR, role: AccountRole.READONLY },
    { address: upgradeAuthority, role: AccountRole.READONLY_SIGNER },
  ];

  instruction.accounts.forEach((account, index) => {
    const expected = expectedAccounts[index];
    if (expected.address !== null) {
      assert(
        eqAddressSol(account.address, expected.address),
        `Unexpected loader Upgrade account ${index}: ${account.address}, expected ${expected.address}`,
      );
    }
    assert(
      account.role === expected.role,
      `Unexpected loader Upgrade role for account ${index}: ${account.role}, expected ${expected.role}`,
    );
  });
}

/**
 * Converts the single mailbox Upgrade transaction emitted by the SVM writer
 * into a receipt accepted by the generic Squads proposer.
 *
 * `waitForSlotAdvance` is safe to remove only in this exact case: buffer
 * preparation has already landed and there are no adjacent authority
 * transactions whose execution must be ordered across slots. The loader
 * structure, expected accounts, roles, and wire payload are checked before
 * the barrier metadata is removed.
 */
export function sanitizeSingleMailboxUpgradeReceiptForSquads({
  transactions,
  mailbox,
  upgradeAuthority,
  spillAddress,
}: {
  transactions: readonly unknown[];
  mailbox: string;
  upgradeAuthority: string;
  spillAddress: string;
}): PrintableSvmTransaction[] {
  const parsedTransactions = ReceiptFileSchema.parse(transactions);
  assert(
    parsedTransactions.length === 1,
    `Expected exactly one mailbox upgrade transaction, got ${parsedTransactions.length}`,
  );
  const transaction = parsedTransactions[0];
  assert(
    transaction.waitForSlotAdvance === true,
    'Expected mailbox upgrade transaction to require waitForSlotAdvance',
  );
  assert(
    transaction.computeUnits === MAX_COMPUTE_UNITS,
    `Expected mailbox upgrade transaction to use ${MAX_COMPUTE_UNITS} compute units`,
  );
  assert(
    transaction.instructions.length === 1,
    `Expected exactly one mailbox upgrade instruction, got ${transaction.instructions.length}`,
  );

  const instruction = transaction.instructions[0];
  assertMailboxUpgradeInstruction({
    instruction,
    mailbox,
    upgradeAuthority,
    spillAddress,
  });

  // Ensures the expanded instruction inspected above exactly matches the
  // canonical v0 wire payload that the proposer will rehydrate.
  validateInstructionsAgainstWire(
    transaction.instructions,
    transaction.transaction_base58,
    [],
  );

  const proposalTransaction = { ...transaction };
  delete proposalTransaction.waitForSlotAdvance;
  return [proposalTransaction];
}
