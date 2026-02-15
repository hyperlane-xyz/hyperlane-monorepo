import type { accounts } from '@sqds/multisig';
import { assert } from '@hyperlane-xyz/utils';

export type SquadsProvider = Parameters<
  typeof accounts.Multisig.fromAccountAddress
>[0];

type ProviderWithOptionalGetAccountInfo =
  | {
      getAccountInfo?: unknown;
    }
  | null
  | undefined;

function formatValueType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function getProviderGetAccountInfo(value: unknown): {
  getAccountInfo: unknown;
  readFailed: boolean;
} {
  try {
    return {
      getAccountInfo: (value as ProviderWithOptionalGetAccountInfo)
        ?.getAccountInfo,
      readFailed: false,
    };
  } catch {
    return {
      getAccountInfo: undefined,
      readFailed: true,
    };
  }
}

function isGetAccountInfoFunction(
  value: unknown,
): value is (...args: unknown[]) => unknown {
  return typeof value === 'function';
}

export function toSquadsProvider(
  provider: unknown,
): SquadsProvider {
  const { getAccountInfo, readFailed } = getProviderGetAccountInfo(provider);
  assert(
    !readFailed,
    `Invalid Solana provider: failed to read getAccountInfo (provider: ${formatValueType(
      provider,
    )})`,
  );

  assert(
    isGetAccountInfoFunction(getAccountInfo),
    `Invalid Solana provider: expected getAccountInfo function, got ${formatValueType(
      getAccountInfo,
    )} (provider: ${formatValueType(provider)})`,
  );

  return provider as SquadsProvider;
}
