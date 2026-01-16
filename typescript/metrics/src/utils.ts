import type { Token } from '@hyperlane-xyz/sdk';

/**
 * Formats a bigint value to a number using the token's decimal precision.
 */
export function formatBigInt(token: Token, num: bigint): number {
  return token.amount(num).getDecimalFormattedAmount();
}
