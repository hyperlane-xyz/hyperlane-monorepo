import { retryAsync } from '@hyperlane-xyz/utils';

import { AnyAleoNetworkClient } from '../clients/base.js';
import { RETRY_ATTEMPTS, RETRY_DELAY_MS } from '../utils/helper.js';

export async function getNewIsmAddress(
  aleoClient: AnyAleoNetworkClient,
  ismManagerProgramId: string,
): Promise<string> {
  let nonce = await retryAsync(
    () =>
      aleoClient.getProgramMappingValue(ismManagerProgramId, 'nonce', 'true'),
    RETRY_ATTEMPTS,
    RETRY_DELAY_MS,
  );

  if (nonce === null) {
    nonce = '0u32';
  }

  const ismAddressRaw = await retryAsync(
    async () => {
      const result = await aleoClient.getProgramMappingValue(
        ismManagerProgramId,
        'ism_addresses',
        nonce!,
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
