import { stringify as yamlStringify } from 'yaml';

import {
  type AnnotatedEV5Transaction,
  type ChainName,
} from '@hyperlane-xyz/sdk';
import { type ProtocolType, errorToString } from '@hyperlane-xyz/utils';

import { type WriteCommandContext } from '../context/types.js';
import { getSubmitterByConfig } from '../deploy/warp.js';
import { logGray, logRed } from '../logger.js';
import { resolveSubmitterBatchesForTransactions } from '../submitters/inference.js';
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
  strategyPath?: string;
}) {
  try {
    const resolvedBatches = await resolveSubmitterBatchesForTransactions({
      chain,
      transactions,
      context,
      strategyUrl: strategyPath,
    });

    for (const resolvedBatch of resolvedBatches) {
      const { submitter } = await getSubmitterByConfig<ProtocolType>({
        chain,
        context,
        submissionStrategy: resolvedBatch.config,
      });
      logGray(
        `Submitting ${resolvedBatch.transactions.length} transaction(s) on ${chain} with submitter ${submitter.txSubmitterType}`,
      );

      const transactionReceipts = await submitter.submit(
        ...(resolvedBatch.transactions as any[]),
      );
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
    }
  } catch (error) {
    const errorMessage = errorToString(error);
    logRed(
      `⛔️ Failed to submit ${transactions.length} transactions:`,
      errorMessage,
    );
    throw new Error(`Failed to submit transactions: ${errorMessage}`);
  }
}

export function getTransactions(
  transactionsFilepath: string,
): AnnotatedEV5Transaction[] {
  return readYamlOrJson<AnnotatedEV5Transaction[]>(transactionsFilepath.trim());
}
