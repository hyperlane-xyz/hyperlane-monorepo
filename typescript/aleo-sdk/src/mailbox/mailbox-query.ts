import { assert } from '@hyperlane-xyz/utils';

import { type AnyAleoNetworkClient } from '../clients/base.js';
import { queryMappingValue } from '../utils/base-query.js';
import { fromAleoAddress } from '../utils/helper.js';
import {
  type AleoMailboxConfig,
  type AleoMailboxData,
} from '../utils/types.js';

/**
 * Query mailbox configuration from the chain.
 *
 * @param aleoClient - The Aleo network client
 * @param mailboxAddress - The full mailbox address (e.g., "mailbox.aleo/aleo1...")
 * @returns The mailbox configuration
 */
export async function getMailboxConfig(
  aleoClient: AnyAleoNetworkClient,
  mailboxAddress: string,
): Promise<AleoMailboxConfig> {
  const { address, programId } = fromAleoAddress(mailboxAddress);

  const mailboxData = await queryMappingValue(
    aleoClient,
    programId,
    'mailboxes',
    address,
    (raw): AleoMailboxData => {
      const data = raw as AleoMailboxData | undefined;
      assert(
        data?.mailbox_owner,
        `Invalid mailbox data structure for mailbox ${mailboxAddress}, expected object with mailbox_owner field`,
      );
      return data;
    },
  );

  return {
    address: mailboxAddress,
    owner: mailboxData.mailbox_owner,
    localDomain: mailboxData.local_domain,
    nonce: mailboxData.nonce,
    defaultIsm: mailboxData.default_ism,
    defaultHook: mailboxData.default_hook,
    requiredHook: mailboxData.required_hook,
  };
}
