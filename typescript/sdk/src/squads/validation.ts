import { assert } from '@hyperlane-xyz/utils';
import { inspectArrayValue } from './inspection.js';

const NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;
const STRING_FUNCTION = String;
const STRING_TRIM = String.prototype.trim;
const REFLECT_APPLY = Reflect.apply as <
  ReturnValue,
  ArgumentValues extends readonly unknown[],
>(
  target: (...args: ArgumentValues) => ReturnValue,
  thisArgument: unknown,
  argumentsList: ArgumentValues,
) => ReturnValue;

function stringTrim(value: string): string {
  return REFLECT_APPLY(STRING_TRIM as () => string, value, []);
}

function numberIsSafeInteger(value: unknown): boolean {
  return NUMBER_IS_SAFE_INTEGER(value);
}

function stringFromValue(value: unknown): string {
  return STRING_FUNCTION(value);
}

function getUnknownValueTypeName(value: unknown): string {
  if (value === null) {
    return 'null';
  }

  const { isArray, readFailed } = inspectArrayValue(value);
  if (readFailed) {
    return '[unreadable value type]';
  }

  return isArray ? 'array' : typeof value;
}

function getChainLabel(chain: unknown): string {
  if (typeof chain !== 'string') {
    return getUnknownValueTypeName(chain);
  }

  const normalizedChain = stringTrim(chain);
  return normalizedChain.length > 0 ? normalizedChain : 'empty string';
}

function formatTransactionIndexValue(transactionIndex: unknown): string {
  if (typeof transactionIndex === 'number') {
    return stringFromValue(transactionIndex);
  }

  return getUnknownValueTypeName(transactionIndex);
}

export function assertValidTransactionIndexInput(
  transactionIndex: unknown,
  chain: unknown,
): number {
  assert(
    typeof transactionIndex === 'number' &&
      numberIsSafeInteger(transactionIndex) &&
      transactionIndex >= 0,
    `Expected transaction index to be a non-negative safe integer for ${getChainLabel(chain)}, got ${formatTransactionIndexValue(transactionIndex)}`,
  );

  return transactionIndex;
}
