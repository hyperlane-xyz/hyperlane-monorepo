import { stringify as yamlStringify } from 'yaml';
import { CommandModule } from 'yargs';

import { objMap, promiseObjAll } from '@hyperlane-xyz/utils';

import {
  createStrategyConfig,
  readChainSubmissionStrategyConfig,
  readSubmissionStrategyConfig,
} from '../config/strategy.js';
import { runSubmit } from '../config/submit.js';
import { CommandModuleWithWriteContext } from '../context/types.js';
import { readChainSubmissionStrategy } from '../deploy/warp.js';
import { log, logCommandHeader, logGray } from '../logger.js';
import { getSubmitterBuilder } from '../submit/submit.js';
import {
  indentYamlOrJson,
  logYamlIfUnderMaxLines,
  writeYamlOrJson,
} from '../utils/files.js';
import { maskSensitiveData } from '../utils/output.js';

import {
  DEFAULT_STRATEGY_CONFIG_PATH,
  outputFileCommandOption,
  strategyCommandOption,
  transactionsCommandOption,
} from './options.js';

/**
 * Parent command
 */
export const strategyCommand: CommandModule = {
  command: 'strategy',
  describe: 'Manage Hyperlane deployment strategies',
  builder: (yargs) =>
    yargs
      .command(init)
      .command(read)
      .command(pending)
      .command(submit)
      .version(false)
      .demandCommand(),
  handler: () => log('Command required'),
};

export const init: CommandModuleWithWriteContext<{
  out: string;
}> = {
  command: 'init',
  describe: 'Creates strategy configuration',
  builder: {
    out: outputFileCommandOption(DEFAULT_STRATEGY_CONFIG_PATH),
  },
  handler: async ({ context, out }) => {
    logCommandHeader(`Hyperlane Strategy Init`);

    await createStrategyConfig({
      context,
      outPath: out,
    });
    process.exit(0);
  },
};

export const read: CommandModuleWithWriteContext<{
  strategy: string;
}> = {
  command: 'read',
  describe: 'Reads strategy configuration',
  builder: {
    strategy: {
      ...strategyCommandOption,
      demandOption: true,
      default: DEFAULT_STRATEGY_CONFIG_PATH,
    },
  },
  handler: async ({ strategy: strategyUrl }) => {
    logCommandHeader(`Hyperlane Strategy Read`);

    const strategy = await readChainSubmissionStrategyConfig(strategyUrl);
    const maskedConfig = maskSensitiveData(strategy);
    log(indentYamlOrJson(yamlStringify(maskedConfig, null, 2), 4));

    process.exit(0);
  },
};

export const pending: CommandModuleWithWriteContext<{
  strategy: string;
  transactions: string;
}> = {
  command: 'pending',
  describe: 'Fetches strategy pending transactions',
  builder: {
    transactions: {
      ...transactionsCommandOption,
      demandOption: false,
      default: './generated/transactions.yaml',
    },
    strategy: {
      ...strategyCommandOption,
      demandOption: true,
    },
  },
  handler: async ({ context, transactions }) => {
    logCommandHeader(`Hyperlane Strategy Pending`);

    const chainStrategy = readChainSubmissionStrategy(context.strategyPath!);

    const pending = await promiseObjAll(
      objMap(chainStrategy, async (_, submissionStrategy) => {
        const submitter = await getSubmitterBuilder({
          submissionStrategy,
          multiProvider: context.multiProvider,
        });
        return submitter.pending();
      }),
    );

    logYamlIfUnderMaxLines(pending);

    logGray(`Writing pending transactions to ${transactions}`);
    writeYamlOrJson(transactions, pending);
  },
};

export const submit: CommandModuleWithWriteContext<{
  strategy: string;
  transactions: string;
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
    transactions,
    strategy: strategyUrl,
    receipts,
  }) => {
    const submissionStrategy = readSubmissionStrategyConfig(strategyUrl);
    await runSubmit({
      context,
      transactionsFilepath: transactions,
      receiptsFilepath: receipts,
      submissionStrategy,
    });
  },
};
