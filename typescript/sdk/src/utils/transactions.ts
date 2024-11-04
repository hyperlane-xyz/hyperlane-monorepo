import { assert } from '@hyperlane-xyz/utils';

import { AnnotatedEV5Transaction } from '../providers/ProviderType.js';
import { ChainName } from '../types.js';

/**
 * Retrieves the chain name from transactions[0].
 *
 * @param multiProvider - The MultiProvider instance to use for chain name lookup.
 * @param transactions - The list of populated transactions.
 * @returns The name of the chain that the transactions are submitted on.
 * @throws If the transactions are not all on the same chain or chain is not found
 */
export function getChainFromTxs(
  transactions: AnnotatedEV5Transaction[],
): ChainName {
  const firstTransaction = transactions[0];
  const sameChainIds = transactions.every(
    (t: AnnotatedEV5Transaction) => t.chain === firstTransaction.chain,
  );
  assert(sameChainIds, 'Transactions must be submitted on the same chains');
  return firstTransaction.chain;
}
