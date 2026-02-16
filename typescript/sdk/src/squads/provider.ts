import type { accounts } from '@sqds/multisig';
import { assert } from '@hyperlane-xyz/utils';
import { stringifyUnknownSquadsError } from './error-format.js';

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
  readError: unknown | undefined;
} {
  try {
    return {
      getAccountInfo: (value as ProviderWithOptionalGetAccountInfo)
        ?.getAccountInfo,
      readError: undefined,
    };
  } catch (error) {
    return {
      getAccountInfo: undefined,
      readError: error,
    };
  }
}

function getProviderThen(value: unknown): {
  thenValue: unknown;
  readError: unknown | undefined;
} {
  try {
    return {
      thenValue: (value as ProviderWithOptionalGetAccountInfo)?.then,
      readError: undefined,
    };
  } catch (error) {
    return {
      thenValue: undefined,
      readError: error,
    };
  }
}

function formatUnknownProviderError(error: unknown): string {
  return stringifyUnknownSquadsError(error, {
    preferErrorMessageForErrorInstances: true,
  });
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

  const { thenValue, readError: thenReadError } = getProviderThen(provider);
  assert(
    !thenReadError,
    `Invalid Solana provider: failed to inspect promise-like then (${formatUnknownProviderError(
      thenReadError,
    )})`,
  );
  assert(
    typeof thenValue !== 'function',
    `Invalid Solana provider: expected synchronous provider, got promise-like value (provider: ${formatValueType(
      provider,
    )})`,
  );

  const { getAccountInfo, readError: getAccountInfoReadError } =
    getProviderGetAccountInfo(provider);
  assert(
    !getAccountInfoReadError,
    `Invalid Solana provider: failed to read getAccountInfo (${formatUnknownProviderError(
      getAccountInfoReadError,
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
