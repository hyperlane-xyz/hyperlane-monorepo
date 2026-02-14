import { accounts } from '@sqds/multisig';
import { assert } from '@hyperlane-xyz/utils';

import type { MultiProtocolProvider } from '../providers/MultiProtocolProvider.js';

export type SquadsProvider = Parameters<
  typeof accounts.Multisig.fromAccountAddress
>[0];

type ProviderWithGetAccountInfo = {
  getAccountInfo: (...args: unknown[]) => unknown;
};

function formatValueType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function hasGetAccountInfoFunction(
  value: unknown,
): value is ProviderWithGetAccountInfo {
  const getAccountInfo = (
    value as { getAccountInfo?: unknown } | null | undefined
  )?.getAccountInfo;
  return typeof getAccountInfo === 'function';
}

export function toSquadsProvider(
  provider: ReturnType<MultiProtocolProvider['getSolanaWeb3Provider']>,
): SquadsProvider {
  const getAccountInfo = (
    provider as { getAccountInfo?: unknown } | null | undefined
  )?.getAccountInfo;

  assert(
    hasGetAccountInfoFunction(provider),
    `Invalid Solana provider: expected getAccountInfo function, got ${formatValueType(
      getAccountInfo,
    )} (provider: ${formatValueType(provider)})`,
  );

  return provider;
}
