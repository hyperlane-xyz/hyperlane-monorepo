import { assert } from '@hyperlane-xyz/utils';

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

function inspectArrayValue(value: unknown): {
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

function getChainLabel(chain: unknown): string {
  if (typeof chain !== 'string') {
    return getUnknownValueTypeName(chain);
  }

  const normalizedChain = chain.trim();
  return normalizedChain.length > 0 ? normalizedChain : 'empty string';
}

function formatTransactionIndexValue(transactionIndex: unknown): string {
  if (typeof transactionIndex === 'number') {
    return String(transactionIndex);
  }

  return getUnknownValueTypeName(transactionIndex);
}

export function assertValidTransactionIndexInput(
  transactionIndex: unknown,
  chain: unknown,
): number {
  assert(
    typeof transactionIndex === 'number' &&
      Number.isSafeInteger(transactionIndex) &&
      transactionIndex >= 0,
    `Expected transaction index to be a non-negative safe integer for ${getChainLabel(chain)}, got ${formatTransactionIndexValue(transactionIndex)}`,
  );

  return transactionIndex;
}
