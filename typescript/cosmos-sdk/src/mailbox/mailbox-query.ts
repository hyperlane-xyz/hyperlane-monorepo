import { type QueryClient } from '@cosmjs/stargate';

import { ZERO_ADDRESS_HEX_32, assert } from '@hyperlane-xyz/utils';

import { type CoreExtension } from '../hyperlane/core/query.js';
import { type CosmosMailboxConfig } from '../utils/types.js';

/**
 * Type alias for query client with Core extension.
 */
export type CosmosMailboxQueryClient = QueryClient & CoreExtension;

/**
 * Query mailbox configuration from the chain.
 */
export async function getMailboxConfig(
  query: CosmosMailboxQueryClient,
  mailboxAddress: string,
): Promise<CosmosMailboxConfig> {
  try {
    const { mailbox } = await query.core.Mailbox({
      id: mailboxAddress,
    });
    assert(mailbox, `No mailbox found at address ${mailboxAddress}`);

    return {
      address: mailbox.id,
      owner: mailbox.owner,
      localDomain: mailbox.local_domain,
      defaultIsm: mailbox.default_ism,
      // Even if the Mailbox type defines these 2 fields as non-nullable
      // if the hooks are not set they are returned as an empty string
      // instead of a proper address
      defaultHook: mailbox.default_hook || ZERO_ADDRESS_HEX_32,
      requiredHook: mailbox.required_hook || ZERO_ADDRESS_HEX_32,
    };
  } catch (error) {
    throw new Error(`Failed to query mailbox config at ${mailboxAddress}`, {
      cause: error,
    });
  }
}
