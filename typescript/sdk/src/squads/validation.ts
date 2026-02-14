import { assert } from '@hyperlane-xyz/utils';

import { ChainName } from '../types.js';

export function assertValidTransactionIndexInput(
  transactionIndex: number,
  chain: ChainName,
): void {
  assert(
    Number.isSafeInteger(transactionIndex) && transactionIndex >= 0,
    `Expected transaction index to be a non-negative safe integer for ${chain}, got ${transactionIndex}`,
  );
}
