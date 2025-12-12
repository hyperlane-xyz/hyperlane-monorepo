import { stringify as yamlStringify } from 'yaml';

import { AnnotatedEV5Transaction, ChainName } from '@hyperlane-xyz/sdk';
import { ProtocolType, errorToString } from '@hyperlane-xyz/utils';

import { WriteCommandContext } from '../context/types.js';
import { getSubmitterByStrategy } from '../deploy/warp.js';
import { logGray, logRed } from '../logger.js';
import {
  indentYamlOrJson,
  readYamlOrJson,
  writeYamlOrJson,
} from '../utils/files.js';

export async function runSubmit({
  context,
  chain,
  transactions,
  receiptsFilepath,
  strategyPath,
}: {
  context: WriteCommandContext;
  chain: ChainName;
  transactions: AnnotatedEV5Transaction[];
  receiptsFilepath: string;
  strategyPath: string;
}) {
  const { submitter } = await getSubmitterByStrategy<ProtocolType>({
    chain,
    context,
    strategyUrl: strategyPath,
  });

  try {
    const transactionReceipts = await submitter.submit(...transactions);
    if (transactionReceipts) {
      logGray(
        '🧾 Transaction receipts:\n\n',
        indentYamlOrJson(yamlStringify(transactionReceipts, null, 2), 4),
      );
      const receiptPath = `${receiptsFilepath}/${chain}-${
        submitter.txSubmitterType
      }-${Date.now()}-receipts.json`;
      writeYamlOrJson(receiptPath, transactionReceipts, 'json');
    }
  } catch (error) {
    logRed(
      `⛔️ Failed to submit ${transactions.length} transactions:`,
      errorToString(error),
    );
    throw new Error('Failed to submit transactions.');
  }
}

export function getTransactions(
  transactionsFilepath: string,
): AnnotatedEV5Transaction[] {
  return readYamlOrJson<AnnotatedEV5Transaction[]>(transactionsFilepath.trim());
}
