import { stringify as yamlStringify } from 'yaml';

import {
  AnnotatedEV5Transaction,
  SubmissionStrategy,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, assert } from '@hyperlane-xyz/utils';

import { WriteCommandContext } from '../context/types.js';
import { logGray } from '../logger.js';
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
  const { multiProvider } = context;

  assert(
    submissionStrategy,
    'Submission strategy required to submit transactions.\nPlease create a submission strategy. See examples in cli/examples/submit/strategy/*.',
  );
  const transactions = getTransactions(transactionsFilepath);

  const submitterBuilder = await getSubmitterBuilder<ProtocolType>({
    submissionStrategy,
    multiProvider,
  });

  const transactionReceipts = await submitterBuilder.submit(...transactions);
  if (transactionReceipts) {
    logGray(
      '🧾 Transaction receipts:\n\n',
      indentYamlOrJson(yamlStringify(transactionReceipts, null, 2), 4),
    );
    writeYamlOrJson(receiptsFilepath, transactionReceipts, 'yaml');
  }
}

function getTransactions(
  transactionsFilepath: string,
): AnnotatedEV5Transaction[] {
  return readYamlOrJson<AnnotatedEV5Transaction[]>(transactionsFilepath.trim());
}
