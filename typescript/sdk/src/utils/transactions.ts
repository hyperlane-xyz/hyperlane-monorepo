import { EvmChainId, assert } from '@hyperlane-xyz/utils';

import { AnnotatedEV5Transaction } from '../providers/ProviderType.js';

/**
 * Retrieves the chain ID from the first transaction and verifies all transactions
 * are for the same chain.
 *
 * @param transactions - The list of populated transactions.
 * @returns The EVM chain ID that the transactions are for.
 * @throws If the transactions are not all for the same chain ID or if chain ID is missing
 */
export function getChainIdFromTxs(
  transactions: AnnotatedEV5Transaction[],
): EvmChainId {
  const firstTransaction = transactions[0];
  const sameChainIds = transactions.every(
    (t: AnnotatedEV5Transaction) => t.chainId === firstTransaction.chainId,
  );
  assert(sameChainIds, 'Transactions must be submitted on the same chains');
  assert(
    firstTransaction.chainId,
    'Invalid PopulatedTransaction: "chainId" is required',
  );
  return firstTransaction.chainId;
}
