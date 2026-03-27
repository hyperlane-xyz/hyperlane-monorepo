import { fromAleoAddress } from '../utils/helper.js';
import { type AleoTransaction } from '../utils/types.js';

/**
 * Build transaction to create a validator announce
 *
 * @param validatorAnnounceProgramId - The validator announce program ID
 * @param mailboxAddress - The plain mailbox address (without program prefix)
 * @param localDomain - The local domain ID
 * @returns The transaction object
 */
export function getCreateValidatorAnnounceTx(
  validatorAnnounceProgramId: string,
  mailboxAddress: string,
  localDomain: number,
): AleoTransaction {
  const { address: mailboxPlainAddress } = fromAleoAddress(mailboxAddress);

  return {
    programName: validatorAnnounceProgramId,
    functionName: 'init',
    priorityFee: 0,
    privateFee: false,
    inputs: [mailboxPlainAddress, `${localDomain}u32`],
  };
}
