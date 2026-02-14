import type { accounts } from '@sqds/multisig';
import { assert } from '@hyperlane-xyz/utils';

import type { MultiProtocolProvider } from '../providers/MultiProtocolProvider.js';

export type SquadsProvider = Parameters<
  typeof accounts.Multisig.fromAccountAddress
>[0];

type ProviderWithOptionalGetAccountInfo =
  | {
      getAccountInfo?: unknown;
    }
  | null
  | undefined;

type ProviderWithGetAccountInfo = {
  getAccountInfo: (...args: unknown[]) => unknown;
};

function formatValueType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function getGetAccountInfo(value: unknown): unknown {
  return (value as ProviderWithOptionalGetAccountInfo)?.getAccountInfo;
}

function hasGetAccountInfoFunction(
  value: unknown,
): value is ProviderWithGetAccountInfo {
  return typeof getGetAccountInfo(value) === 'function';
}

export function toSquadsProvider(
  provider: ReturnType<MultiProtocolProvider['getSolanaWeb3Provider']>,
): SquadsProvider {
  const getAccountInfo = getGetAccountInfo(provider);

  assert(
    hasGetAccountInfoFunction(provider),
    `Invalid Solana provider: expected getAccountInfo function, got ${formatValueType(
      getAccountInfo,
    )} (provider: ${formatValueType(provider)})`,
  );

  return provider;
}
