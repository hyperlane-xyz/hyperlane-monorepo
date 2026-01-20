import { retryAsync } from '@hyperlane-xyz/utils';

import { type AnyAleoNetworkClient } from '../clients/base.js';
import { RETRY_ATTEMPTS, RETRY_DELAY_MS } from '../utils/helper.js';

/**
 * Get the newly created hook address after hook creation transaction.
 * This should be called AFTER the hook creation transaction has been confirmed.
 *
 * @param aleoClient - The Aleo network client
 * @param hookManagerProgramId - The hook manager program ID
 * @param nonce - The nonce captured before hook creation
 * @returns The full hook address (e.g., "hook_manager_xxx.aleo/aleo1...")
 *
 * @example
 * ```typescript
 * const expectedNonce = await getNewContractExpectedNonce(client, hookManagerProgramId);
 * const receipt = await signer.sendAndConfirmTransaction(createHookTx);
 * const hookAddress = await getNewHookAddress(client, hookManagerProgramId, expectedNonce);
 * ```
 */
export async function getNewHookAddress(
  aleoClient: AnyAleoNetworkClient,
  hookManagerProgramId: string,
  nonce: string,
): Promise<string> {
  const hookAddressRaw = await retryAsync(
    async () => {
      const result = await aleoClient.getProgramMappingValue(
        hookManagerProgramId,
        'hook_addresses',
        nonce,
      );
      if (result === null) {
        throw new Error(
          `could not read hook address with nonce ${nonce} from hook_manager ${hookManagerProgramId}`,
        );
      }
      return result;
    },
    RETRY_ATTEMPTS,
    RETRY_DELAY_MS,
  );

  return `${hookManagerProgramId}/${hookAddressRaw}`;
}
