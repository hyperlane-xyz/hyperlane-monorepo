import type { accounts } from '@sqds/multisig';
import { assert } from '@hyperlane-xyz/utils';

export type SquadsProvider = Parameters<
  typeof accounts.Multisig.fromAccountAddress
>[0];

type ProviderWithOptionalGetAccountInfo =
  | {
      getAccountInfo?: unknown;
      then?: unknown;
    }
  | null
  | undefined;

const UNREADABLE_VALUE_TYPE = '[unreadable value type]';

function getArrayInspection(value: unknown): {
  isArray: boolean;
  readFailed: boolean;
} {
  try {
    return {
      isArray: Array.isArray(value),
      readFailed: false,
    };
  } catch {
    return {
      isArray: false,
      readFailed: true,
    };
  }
}

function formatValueType(value: unknown): string {
  if (value === null) return 'null';
  const { isArray, readFailed } = getArrayInspection(value);
  if (readFailed) return UNREADABLE_VALUE_TYPE;
  if (isArray) return 'array';
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

function getProviderThen(value: unknown): {
  thenValue: unknown;
  readFailed: boolean;
} {
  try {
    return {
      thenValue: (value as ProviderWithOptionalGetAccountInfo)?.then,
      readFailed: false,
    };
  } catch {
    return {
      thenValue: undefined,
      readFailed: true,
    };
  }
}

function isGetAccountInfoFunction(
  value: unknown,
): value is (...args: unknown[]) => unknown {
  return typeof value === 'function';
}

export function toSquadsProvider(provider: unknown): SquadsProvider {
  const { isArray: providerIsArray, readFailed: providerTypeReadFailed } =
    getArrayInspection(provider);

  assert(
    typeof provider === 'object' &&
      provider !== null &&
      !providerTypeReadFailed &&
      !providerIsArray,
    `Invalid Solana provider: expected object, got ${formatValueType(provider)}`,
  );

  const { thenValue, readFailed: thenReadFailed } = getProviderThen(provider);
  assert(
    !thenReadFailed,
    `Invalid Solana provider: failed to inspect promise-like then (provider: ${formatValueType(
      provider,
    )})`,
  );
  assert(
    typeof thenValue !== 'function',
    `Invalid Solana provider: expected synchronous provider, got promise-like value (provider: ${formatValueType(
      provider,
    )})`,
  );

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
