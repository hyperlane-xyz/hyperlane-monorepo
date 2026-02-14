import { accounts } from '@sqds/multisig';

import { MultiProtocolProvider } from '../providers/MultiProtocolProvider.js';

export type SquadsProvider = Parameters<
  typeof accounts.Multisig.fromAccountAddress
>[0];

export function toSquadsProvider(
  provider: ReturnType<MultiProtocolProvider['getSolanaWeb3Provider']>,
): SquadsProvider {
  // Squads SDK expects a narrower connection type than sdk providers expose.
  return provider as unknown as SquadsProvider;
}
