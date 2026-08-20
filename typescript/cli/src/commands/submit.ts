import { groupBy } from 'lodash-es';

import {
  type SubmissionStrategy,
  SubmissionStrategySchema,
} from '@hyperlane-xyz/sdk';
import { assert } from '@hyperlane-xyz/utils';

import {
  getTransactions,
  runExternalSubmit,
  runSubmit,
} from '../config/submit.js';
import { loadExternalEvmSigner } from '../context/externalSigner.js';
import { type CommandModuleWithWriteContext } from '../context/types.js';
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
  strategy?: string;
  signerConfig?: string;
  receipts: string;
}> = {
  command: 'submit',
  describe: 'Submit transactions',
  builder: {
    transactions: transactionsCommandOption,
    strategy: strategyCommandOption,
    'signer-config': {
      type: 'string',
      description:
        'Path to a private external signer JSON config. Submits directly on EVM chains; cannot be combined with --strategy. Each transaction must estimate independently against current state; split dependent sequences into separate runs',
    },
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
    signerConfig: signerConfigPath,
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

    assert(
      !(strategyPath && signerConfigPath),
      '--strategy cannot be combined with --signer-config',
    );
    const transactions = getTransactions(transactionsPath);

    if (signerConfigPath) {
      const signer = await loadExternalEvmSigner(signerConfigPath);
      await runExternalSubmit({
        context,
        signer,
        transactions,
        receiptsFilepath,
      });
      logBlue('✅ External signer submission complete');
      process.exit(0);
    }

    const chainTransactions = groupBy(transactions, 'chainId');

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
