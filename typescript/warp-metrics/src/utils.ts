import type { Logger } from 'pino';

import type { Token } from '@hyperlane-xyz/sdk';

/**
 * Wraps an async function and catches any errors, logging them.
 *
 * @param fn - The async function to execute
 * @param context - A description of the context for error logging
 * @param logger - The logger instance
 */
export async function tryFn(
  fn: () => Promise<void>,
  context: string,
  logger: Logger,
): Promise<void> {
  try {
    await fn();
  } catch (error) {
    logger.error({ context, err: error as Error }, `Error in ${context}`);
  }
}

/**
 * Formats a bigint value to a number using the token's decimal precision.
 *
 * @param token - The token to use for formatting
 * @param num - The bigint value to format
 * @returns The formatted number
 */
export function formatBigInt(token: Token, num: bigint): number {
  return token.amount(num).getDecimalFormattedAmount();
}
