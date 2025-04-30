import { Token } from '@hyperlane-xyz/sdk';
import { rootLogger } from '@hyperlane-xyz/utils';

export const logger = rootLogger.child({ module: 'warp-balance-monitor' });

export async function tryFn(fn: () => Promise<void>, context: string) {
  try {
    await fn();
  } catch (e) {
    logger.error(`Error in ${context}`, e);
  }
}

export function formatBigInt(warpToken: Token, num: bigint): number {
  return warpToken.amount(num).getDecimalFormattedAmount();
}
