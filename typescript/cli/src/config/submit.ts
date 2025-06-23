import { stringify as yamlStringify } from 'yaml';

import {
  AnnotatedEV5Transaction,
  SubmissionStrategy,
  getSubmitterBuilder,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, assert, errorToString } from '@hyperlane-xyz/utils';

import { WriteCommandContext } from '../context/types.js';
import { logGray, logRed } from '../logger.js';
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
  const { multiProvider } = context;

  assert(
    submissionStrategy,
    'Submission strategy required to submit transactions.\nPlease create a submission strategy. See examples in cli/examples/submit/strategy/*.',
  );
  const transactions = getTransactions(transactionsFilepath);

  const submitterBuilder = await getSubmitterBuilder<ProtocolType>({
    submissionStrategy,
    multiProvider,
    registry: context.registry,
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

function getTransactions(
  transactionsFilepath: string,
): AnnotatedEV5Transaction[] {
  return readYamlOrJson<AnnotatedEV5Transaction[]>(transactionsFilepath.trim());
}
