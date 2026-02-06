import { assert, isZeroishAddress } from '@hyperlane-xyz/utils';

import { type AnyAleoNetworkClient } from '../clients/base.js';
import { queryMappingValue } from '../utils/base-query.js';
import {
  ALEO_NULL_ADDRESS,
  MAINNET_PREFIX,
  TESTNET_PREFIX,
  fromAleoAddress,
  getProgramIdFromSuffix,
  getProgramSuffix,
} from '../utils/helper.js';
import {
  type AleoMailboxConfig,
  type AleoMailboxData,
  type OnChainArtifactManagers,
} from '../utils/types.js';

/**
 * Format ISM address by combining manager program ID with plain address.
 * Returns null address for zeroish addresses.
 */
function formatIsmAddress(ismAddress: string, ismManager: string): string {
  if (isZeroishAddress(ismAddress)) {
    return ALEO_NULL_ADDRESS;
  }
  return `${ismManager}/${ismAddress}`;
}

/**
 * Format Hook address by combining manager program ID with plain address.
 * Returns null address for zeroish addresses.
 */
function formatHookAddress(hookAddress: string, hookManager: string): string {
  if (isZeroishAddress(hookAddress)) {
    return ALEO_NULL_ADDRESS;
  }
  return `${hookManager}/${hookAddress}`;
}

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
  onChainArtifactManagers: OnChainArtifactManagers,
): Promise<AleoMailboxConfig> {
  const { programId } = fromAleoAddress(mailboxAddress);

  const mailboxData = await queryMappingValue(
    aleoClient,
    programId,
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

  // Derive prefix from mailbox program ID
  const prefix = programId.startsWith(TESTNET_PREFIX)
    ? TESTNET_PREFIX
    : MAINNET_PREFIX;

  // Derive hook manager from mailbox's suffix (ignoring hookManagerAddress from parameter)
  const mailboxSuffix = getProgramSuffix(programId);
  const hookManager = getProgramIdFromSuffix(
    prefix,
    'hook_manager',
    mailboxSuffix,
  );

  return {
    address: mailboxAddress,
    owner: mailboxData.mailbox_owner,
    localDomain: mailboxData.local_domain,
    nonce: mailboxData.nonce,
    defaultIsm: formatIsmAddress(
      mailboxData.default_ism,
      onChainArtifactManagers.ismManagerAddress,
    ),
    defaultHook: formatHookAddress(mailboxData.default_hook, hookManager),
    requiredHook: formatHookAddress(mailboxData.required_hook, hookManager),
  };
}
