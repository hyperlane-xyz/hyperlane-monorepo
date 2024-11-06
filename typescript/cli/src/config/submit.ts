import { stringify as yamlStringify } from 'yaml';

import {
  AnnotatedEV5Transaction,
  SubmissionStrategy,
} from '@hyperlane-xyz/sdk';
import { MultiProvider } from '@hyperlane-xyz/sdk';
import { assert, errorToString } from '@hyperlane-xyz/utils';

import { WriteCommandContext } from '../context/types.js';
import { logGray, logRed } from '../logger.js';
import { getSubmitterBuilder } from '../submit/submit.js';
import {
  indentYamlOrJson,
  readYamlOrJson,
  writeYamlOrJson,
} from '../utils/files.js';

export async function runSubmit({
  context,
  transactionsFilepath,
  receiptsFilepath,
  submissionStrategy,
}: {
  context: WriteCommandContext;
  transactionsFilepath: string;
  receiptsFilepath: string;
  submissionStrategy: SubmissionStrategy;
}) {
  const { chainMetadata, multiProvider } = context;

  assert(
    submissionStrategy,
    'Submission strategy required to submit transactions.\nPlease create a submission strategy. See examples in cli/examples/submit/strategy/*.',
  );
  const transactions = getTransactions(transactionsFilepath);
  const chain = getChainFromTxs(multiProvider, transactions);

  const protocol = chainMetadata[chain].protocol;
  const submitterBuilder = await getSubmitterBuilder<typeof protocol>({
    submissionStrategy,
    multiProvider,
  });

  try {
    const transactionReceipts = await submitterBuilder.submit(...transactions);
    if (transactionReceipts) {
      logGray(
        '🧾 Transaction receipts:\n\n',
        indentYamlOrJson(yamlStringify(transactionReceipts, null, 2), 4),
      );
      writeYamlOrJson(receiptsFilepath, transactionReceipts, 'yaml');
    }
  } catch (error) {
    logRed(
      `⛔️ Failed to submit ${transactions.length} transactions:`,
      errorToString(error),
    );
    throw new Error('Failed to submit transactions.');
  }
}

/**
 * Retrieves the chain name from transactions[0].
 *
 * @param multiProvider - The MultiProvider instance to use for chain name lookup.
 * @param transactions - The list of populated transactions.
 * @returns The name of the chain that the transactions are submitted on.
 * @throws If the transactions are not all on the same chain or chain is not found
 */
function getChainFromTxs(
  multiProvider: MultiProvider,
  transactions: AnnotatedEV5Transaction[],
) {
  const firstTransaction = transactions[0];
  assert(firstTransaction.chainId, 'Invalid transaction: chainId is required');
  const sameChainIds = transactions.every(
    (t: AnnotatedEV5Transaction) => t.chainId === firstTransaction.chainId,
  );
  assert(sameChainIds, 'Transactions must be submitted on the same chains');

  return multiProvider.getChainName(firstTransaction.chainId);
}

function getTransactions(
  transactionsFilepath: string,
): AnnotatedEV5Transaction[] {
  return readYamlOrJson<AnnotatedEV5Transaction[]>(transactionsFilepath.trim());
}
