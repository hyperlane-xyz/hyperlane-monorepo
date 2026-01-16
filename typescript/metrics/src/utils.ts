import type { Token } from '@hyperlane-xyz/sdk';

/**
 * Formats a bigint value to a number using the token's decimal precision.
 * Returns 0 if the result is non-finite (NaN, Infinity) to avoid Prometheus dropping the metric.
 */
export function formatBigInt(token: Token, num: bigint): number {
  const result = Number(token.amount(num).getDecimalFormattedAmount());
  return Number.isFinite(result) ? result : 0;
}
