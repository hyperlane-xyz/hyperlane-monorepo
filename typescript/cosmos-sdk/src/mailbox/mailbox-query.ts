import { type QueryClient } from '@cosmjs/stargate';

import { assert } from '@hyperlane-xyz/utils';

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
  address: string,
): Promise<CosmosMailboxConfig> {
  try {
    const { mailbox } = await query.core.Mailbox({
      id: address,
    });
    assert(mailbox, `No mailbox found at address ${address}`);

    return {
      address: mailbox.id,
      owner: mailbox.owner,
      localDomain: mailbox.local_domain,
      defaultIsm: mailbox.default_ism,
      defaultHook: mailbox.default_hook,
      requiredHook: mailbox.required_hook,
    };
  } catch (error) {
    throw new Error(
      `Failed to query mailbox config at ${address}: ${(error as Error).message}`,
    );
  }
}
