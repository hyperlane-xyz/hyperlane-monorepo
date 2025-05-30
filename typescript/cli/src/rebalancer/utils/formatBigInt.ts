import { Token } from '@hyperlane-xyz/sdk';

export function formatBigInt(warpToken: Token, num: bigint): number {
  return warpToken.amount(num).getDecimalFormattedAmount();
}
