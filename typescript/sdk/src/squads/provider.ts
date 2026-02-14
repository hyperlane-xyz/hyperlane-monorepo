import { accounts } from '@sqds/multisig';
import { assert } from '@hyperlane-xyz/utils';

import { MultiProtocolProvider } from '../providers/MultiProtocolProvider.js';

export type SquadsProvider = Parameters<
  typeof accounts.Multisig.fromAccountAddress
>[0];

export function toSquadsProvider(
  provider: ReturnType<MultiProtocolProvider['getSolanaWeb3Provider']>,
): SquadsProvider {
  assert(
    typeof (provider as { getAccountInfo?: unknown }).getAccountInfo ===
      'function',
    'Invalid Solana provider: missing getAccountInfo function',
  );

  // Squads SDK expects a narrower connection type than sdk providers expose.
  return provider as SquadsProvider;
}
