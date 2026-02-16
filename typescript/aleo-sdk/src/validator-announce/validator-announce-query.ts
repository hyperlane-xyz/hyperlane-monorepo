import { assert } from '@hyperlane-xyz/utils';

import { type AnyAleoNetworkClient } from '../clients/base.js';
import { queryMappingValue } from '../utils/base-query.js';
import { fromAleoAddress } from '../utils/helper.js';

interface ValidatorAnnounceData {
  mailbox: string;
}

/**
 * Query validator announce configuration from the chain.
 *
 * @param aleoClient - The Aleo network client
 * @param validatorAnnounceAddress - The full validator announce address (e.g., "validator_announce.aleo/aleo1...")
 * @returns The validator announce configuration with address and mailbox address
 */
export async function getValidatorAnnounceConfig(
  aleoClient: AnyAleoNetworkClient,
  validatorAnnounceAddress: string,
): Promise<{ address: string; mailboxAddress: string }> {
  const { programId } = fromAleoAddress(validatorAnnounceAddress);

  const validatorAnnounceData = await queryMappingValue(
    aleoClient,
    programId,
    'validator_announce',
    'true',
    (raw): ValidatorAnnounceData => {
      const data = raw as ValidatorAnnounceData | undefined;
      assert(
        data?.mailbox,
        `Invalid validator announce data structure for validator announce ${validatorAnnounceAddress}, expected object with mailbox field`,
      );
      return data;
    },
  );

  return {
    address: validatorAnnounceAddress,
    mailboxAddress: validatorAnnounceData.mailbox,
  };
}
