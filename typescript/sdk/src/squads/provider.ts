import { accounts } from '@sqds/multisig';
import { assert } from '@hyperlane-xyz/utils';

import { MultiProtocolProvider } from '../providers/MultiProtocolProvider.js';

export type SquadsProvider = Parameters<
  typeof accounts.Multisig.fromAccountAddress
>[0];

function formatValueType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

export function toSquadsProvider(
  provider: ReturnType<MultiProtocolProvider['getSolanaWeb3Provider']>,
): SquadsProvider {
  const getAccountInfo = (
    provider as { getAccountInfo?: unknown } | null | undefined
  )?.getAccountInfo;

  assert(
    typeof getAccountInfo === 'function',
    `Invalid Solana provider: expected getAccountInfo function, got ${formatValueType(
      getAccountInfo,
    )}`,
  );

  // Squads SDK expects a narrower connection type than sdk providers expose.
  return provider as SquadsProvider;
}
