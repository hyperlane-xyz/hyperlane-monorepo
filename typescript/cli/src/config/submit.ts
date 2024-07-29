import { stringify as yamlStringify } from 'yaml';

import {
  PopulatedTransactions,
  PopulatedTransactionsSchema,
} from '@hyperlane-xyz/sdk';
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
}: {
  context: WriteCommandContext;
  transactionsFilepath: string;
  receiptsFilepath: string;
}) {
  const { submissionStrategy, chainMetadata, multiProvider } = context;

  assert(
    submissionStrategy,
    'Submission strategy required to submit transactions.\nPlease create a submission strategy. See examples in cli/examples/submit/strategy/*.',
  );

  const chain = submissionStrategy.chain;
  const protocol = chainMetadata[chain].protocol;
  const submitterBuilder = await getSubmitterBuilder<typeof protocol>({
    submissionStrategy,
    multiProvider,
  });
  const transactions = getTransactions(transactionsFilepath);

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

function getTransactions(transactionsFilepath: string): PopulatedTransactions {
  const transactionsFileContent = readYamlOrJson<any[]>(
    transactionsFilepath.trim(),
  );
  return PopulatedTransactionsSchema.parse(transactionsFileContent);
}
