import { assert } from '@hyperlane-xyz/utils';

function getUnknownValueTypeName(value: unknown): string {
  if (value === null) {
    return 'null';
  }

  return Array.isArray(value) ? 'array' : typeof value;
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
