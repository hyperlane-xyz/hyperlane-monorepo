import { rootLogger } from '@hyperlane-xyz/utils';

export const logger = rootLogger.child({ module: 'warp-balance-monitor' });

export async function tryFn(fn: () => Promise<void>, context: string) {
  try {
    await fn();
  } catch (err) {
    logger.error(err, `Error in ${context}`);
  }
}
