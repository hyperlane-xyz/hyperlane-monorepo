import { runSubmit } from '../config/submit.js';
import { CommandModuleWithWriteContext } from '../context/types.js';
import { logBlue, logGray } from '../logger.js';

import {
  dryRunCommandOption,
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
  'dry-run': string;
  receipts: string;
}> = {
  command: 'submit',
  describe: 'Submit transactions',
  builder: {
    transactions: transactionsCommandOption,
    strategy: strategyCommandOption,
    'dry-run': dryRunCommandOption,
    receipts: outputFileCommandOption('./generated/transactions/receipts.yaml'),
  },
  handler: async ({ context, transactions, receipts }) => {
    logGray(`Hyperlane Submit`);
    logGray(`----------------`);

    await runSubmit({
      context,
      transactionsFilepath: transactions,
      receiptsFilepath: receipts,
    });

    logBlue(`✅ Submission complete`);
    process.exit(0);
  },
};
