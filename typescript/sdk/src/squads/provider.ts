import type { accounts } from '@sqds/multisig';
import { assert } from '@hyperlane-xyz/utils';
import { stringifyUnknownSquadsError } from './error-format.js';
import {
  inspectArrayValue,
  inspectPropertyValue,
  inspectPromiseLikeThenValue,
} from './inspection.js';

export type SquadsProvider = Parameters<
  typeof accounts.Multisig.fromAccountAddress
>[0];

const UNREADABLE_VALUE_TYPE = '[unreadable value type]';

function formatValueType(value: unknown): string {
  if (value === null) return 'null';
  const { isArray, readFailed } = inspectArrayValue(value);
  if (readFailed) return UNREADABLE_VALUE_TYPE;
  if (isArray) return 'array';
  return typeof value;
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
    inspectArrayValue(provider);

  assert(
    typeof provider === 'object' &&
      provider !== null &&
      !providerTypeReadFailed &&
      !providerIsArray,
    `Invalid Solana provider: expected object, got ${formatValueType(provider)}`,
  );

  const { thenValue, readError: thenReadError } =
    inspectPromiseLikeThenValue(provider);
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

  const { propertyValue: getAccountInfo, readError: getAccountInfoReadError } =
    inspectPropertyValue(provider, 'getAccountInfo');
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
