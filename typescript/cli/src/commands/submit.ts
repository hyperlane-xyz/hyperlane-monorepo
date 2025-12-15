import { groupBy } from 'lodash-es';

import {
  SubmissionStrategy,
  SubmissionStrategySchema,
} from '@hyperlane-xyz/sdk';

import { getTransactions, runSubmit } from '../config/submit.js';
import { CommandModuleWithWriteContext } from '../context/types.js';
import { logBlue, logGray, logRed } from '../logger.js';
import { isFile, readYamlOrJson } from '../utils/files.js';

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
    receipts: outputFileCommandOption(
      './generated/transactions/receipts',
      false,
      'Output directory for transaction receipts',
    ),
  },
  handler: async ({
    context,
    transactions: transactionsPath,
    strategy: strategyPath,
    receipts: receiptsFilepath,
  }) => {
    logGray(`Hyperlane Submit`);
    logGray(`----------------`);

    // Defensive check: if receiptsFilepath exists and is a file, fail with clear error
    if (isFile(receiptsFilepath)) {
      logRed(
        `❌ Error: receipts path '${receiptsFilepath}' exists but is a file. Expected a directory.`,
      );
      process.exit(1);
    }

    const chainTransactions = groupBy(
      getTransactions(transactionsPath),
      'chainId',
    );

    for (const [chainId, transactions] of Object.entries(chainTransactions)) {
      const chain = context.multiProvider.getChainName(chainId);

      await runSubmit({
        context,
        chain,
        transactions,
        strategyPath,
        receiptsFilepath,
      });
      logBlue(`✅ Submission complete for chain ${chain}`);
    }

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
