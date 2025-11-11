import { groupBy } from 'lodash-es';

import {
  SubmissionStrategy,
  SubmissionStrategySchema,
} from '@hyperlane-xyz/sdk';
import { objMap, promiseObjAll } from '@hyperlane-xyz/utils';

import { getTransactions, runSubmit } from '../config/submit.js';
import { CommandModuleWithWriteContext } from '../context/types.js';
import { logBlue, logGray } from '../logger.js';
import { readYamlOrJson } from '../utils/files.js';

import {
  outputFileCommandOption,
  strategyCommandOption,
  transactionsCommandOption,
} from './options.js';

/**
 * Submit command
 */
export const submitCommand: CommandModuleWithWriteContext<{
  transactions: string;
  strategy: string;
  receipts: string;
}> = {
  command: 'submit',
  describe: 'Submit transactions',
  builder: {
    transactions: transactionsCommandOption,
    strategy: strategyCommandOption,
    receipts: outputFileCommandOption('./generated/transactions/receipts.yaml'),
  },
  handler: async ({
    context,
    transactions: transactionsPath,
    strategy: strategyPath,
    receipts: receiptsFilepath,
  }) => {
    logGray(`Hyperlane Submit`);
    logGray(`----------------`);

    const chainTransactions = groupBy(
      getTransactions(transactionsPath),
      'chainId',
    );

    await promiseObjAll(
      objMap(chainTransactions, async (chainId, transactions) => {
        const chain = context.multiProvider.getChainName(chainId);

        await runSubmit({
          context,
          chain,
          transactions,
          strategyPath,
          receiptsFilepath,
        });
        logBlue(`✅ Submission complete for chain ${chain}`);
      }),
    );

    process.exit(0);
  },
};

/**
 * Retrieves a submission strategy from the provided filepath.
 * @param submissionStrategyFilepath a filepath to the submission strategy file
 * @returns a formatted submission strategy
 */
export function readSubmissionStrategy(
  submissionStrategyFilepath: string,
): SubmissionStrategy {
  const submissionStrategyFileContent = readYamlOrJson(
    submissionStrategyFilepath.trim(),
  );
  return SubmissionStrategySchema.parse(submissionStrategyFileContent);
}
