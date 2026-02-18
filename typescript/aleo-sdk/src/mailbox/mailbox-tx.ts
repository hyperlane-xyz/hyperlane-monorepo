import { fromAleoAddress } from '../utils/helper.js';
import { type AleoTransaction } from '../utils/types.js';

/**
 * Build transaction to create a mailbox
 *
 * @param mailboxProgramId - The mailbox program ID
 * @param domainId - The local domain ID
 * @returns The transaction object
 */
export function getCreateMailboxTx(
  mailboxProgramId: string,
  domainId: number,
): AleoTransaction {
  return {
    programName: mailboxProgramId,
    functionName: 'init',
    priorityFee: 0,
    privateFee: false,
    inputs: [`${domainId}u32`],
  };
}

/**
 * Build transaction to set mailbox owner
 *
 * @param mailboxAddress - The full mailbox address (e.g., "mailbox.aleo/aleo1...")
 * @param newOwner - The new owner address
 * @returns The transaction object
 */
export function getSetMailboxOwnerTx(
  mailboxAddress: string,
  newOwner: string,
): AleoTransaction {
  const { programId } = fromAleoAddress(mailboxAddress);

  return {
    programName: programId,
    functionName: 'set_owner',
    priorityFee: 0,
    privateFee: false,
    inputs: [newOwner],
  };
}

/**
 * Build transaction to set mailbox default ISM
 *
 * @param mailboxAddress - The full mailbox address (e.g., "mailbox.aleo/aleo1...")
 * @param ismAddress - The full ISM address
 * @returns The transaction object
 */
export function getSetMailboxDefaultIsmTx(
  mailboxAddress: string,
  ismAddress: string,
): AleoTransaction {
  const { programId } = fromAleoAddress(mailboxAddress);
  const { address } = fromAleoAddress(ismAddress);

  return {
    programName: programId,
    functionName: 'set_default_ism',
    priorityFee: 0,
    privateFee: false,
    inputs: [address],
  };
}

/**
 * Build transaction to set mailbox default hook
 *
 * @param mailboxAddress - The full mailbox address (e.g., "mailbox.aleo/aleo1...")
 * @param hookAddress - The full hook address
 * @returns The transaction object
 */
export function getSetMailboxDefaultHookTx(
  mailboxAddress: string,
  hookAddress: string,
): AleoTransaction {
  const { programId } = fromAleoAddress(mailboxAddress);
  const { address } = fromAleoAddress(hookAddress);

  return {
    programName: programId,
    functionName: 'set_default_hook',
    priorityFee: 0,
    privateFee: false,
    inputs: [address],
  };
}

/**
 * Build transaction to set mailbox required hook
 *
 * @param mailboxAddress - The full mailbox address (e.g., "mailbox.aleo/aleo1...")
 * @param hookAddress - The full hook address
 * @returns The transaction object
 */
export function getSetMailboxRequiredHookTx(
  mailboxAddress: string,
  hookAddress: string,
): AleoTransaction {
  const { programId } = fromAleoAddress(mailboxAddress);
  const { address } = fromAleoAddress(hookAddress);

  return {
    programName: programId,
    functionName: 'set_required_hook',
    priorityFee: 0,
    privateFee: false,
    inputs: [address],
  };
}
