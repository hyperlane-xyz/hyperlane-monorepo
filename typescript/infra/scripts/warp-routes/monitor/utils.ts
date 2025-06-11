import { rootLogger } from '@hyperlane-xyz/utils';

export const logger = rootLogger.child({ module: 'warp-balance-monitor' });

/**
 * Executes an asynchronous function and logs any errors with contextual information.
 *
 * @param fn - The asynchronous function to execute.
 * @param context - A string describing the context in which {@link fn} is executed, included in error logs.
 */
export async function tryFn(fn: () => Promise<void>, context: string) {
  try {
    await fn();
  } catch (err) {
    logger.error(err, `Error in ${context}`);
  }
}
