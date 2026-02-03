import { retryAsync } from '@hyperlane-xyz/utils';

import { type AnyAleoNetworkClient } from '../clients/base.js';
import { RETRY_ATTEMPTS, RETRY_DELAY_MS } from '../utils/helper.js';

/**
 * Retrieves the address of a newly created ISM from the ISM manager contract.
 *
 * This function queries the ISM manager's nonce to get the current count of created ISMs,
 * then uses that nonce to look up the most recently created ISM address from the
 * `ism_addresses` mapping.
 *
 * @param aleoClient - The Aleo network client for querying contract state
 * @param ismManagerProgramId - The program ID of the ISM manager contract
 * @returns The full ISM address in the format "programId/address"
 * @throws Error if the ISM address cannot be read from the ISM manager
 */
export async function getNewIsmAddress(
  aleoClient: Readonly<AnyAleoNetworkClient>,
  ismManagerProgramId: string,
  nonce: string,
): Promise<string> {
  const ismAddressRaw = await retryAsync(
    async () => {
      const result = await aleoClient.getProgramMappingValue(
        ismManagerProgramId,
        'ism_addresses',
        nonce,
      );
      if (result === null) {
        throw new Error(
          `could not read ism address with nonce ${nonce} from ism_manager`,
        );
      }
      return result;
    },
    RETRY_ATTEMPTS,
    RETRY_DELAY_MS,
  );

  return `${ismManagerProgramId}/${ismAddressRaw}`;
}
