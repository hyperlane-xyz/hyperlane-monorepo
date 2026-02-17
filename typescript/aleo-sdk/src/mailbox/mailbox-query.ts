import { assert } from '@hyperlane-xyz/utils';

import { type AnyAleoNetworkClient } from '../clients/base.js';
import { queryMappingValue } from '../utils/base-query.js';
import {
  formatHookAddress,
  formatIsmAddress,
  fromAleoAddress,
} from '../utils/helper.js';
import {
  type AleoMailboxConfig,
  type AleoMailboxData,
} from '../utils/types.js';

/**
 * Query mailbox configuration from the chain.
 *
 * @param aleoClient - The Aleo network client
 * @param mailboxAddress - The full mailbox address (e.g., "mailbox.aleo/aleo1...")
 * @param onChainArtifactManagers - Artifact manager addresses (hookManagerAddress is ignored and derived from mailbox)
 * @returns The mailbox configuration
 */
export async function getMailboxConfig(
  aleoClient: AnyAleoNetworkClient,
  mailboxAddress: string,
): Promise<AleoMailboxConfig> {
  const { programId: mailboxProgramId } = fromAleoAddress(mailboxAddress);

  const mailboxData = await queryMappingValue(
    aleoClient,
    mailboxProgramId,
    'mailbox',
    'true',
    (raw): AleoMailboxData => {
      const data = raw as AleoMailboxData | undefined;
      assert(
        data?.mailbox_owner,
        `Invalid mailbox data structure for mailbox ${mailboxAddress}, expected object with mailbox_owner field`,
      );
      return data;
    },
  );

  const imports = await aleoClient.getProgramImportNames(mailboxProgramId);
  const ismManagerProgramId = imports.find((i) => i.includes('ism_manager'));
  assert(
    ismManagerProgramId,
    `Expected to find ISM manager program id in mailbox program at ${mailboxAddress}`,
  );

  return {
    address: mailboxAddress,
    owner: mailboxData.mailbox_owner,
    localDomain: mailboxData.local_domain,
    nonce: mailboxData.nonce,
    defaultIsm: formatIsmAddress(mailboxData.default_ism, ismManagerProgramId),
    defaultHook: formatHookAddress(mailboxData.default_hook, mailboxProgramId),
    requiredHook: formatHookAddress(
      mailboxData.required_hook,
      mailboxProgramId,
    ),
  };
}
