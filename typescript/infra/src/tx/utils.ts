import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';

import { rootLogger, stringifyObject } from '@hyperlane-xyz/utils';
import { writeYaml } from '@hyperlane-xyz/utils/fs';

import { GovernTransaction } from './govern-transaction-reader.js';

type ConfirmPrompt = (options: {
  message: string;
  default: boolean;
}) => Promise<boolean>;

export function processGovernorReaderResult(
  result: [string, GovernTransaction][],
  errors: any[],
  outputFileName: string,
) {
  if (errors.length) {
    rootLogger.error(
      chalk.red('❌❌❌❌❌ Encountered fatal errors ❌❌❌❌❌'),
    );
    rootLogger.info(stringifyObject(errors, 'yaml', 2));
    rootLogger.error(
      chalk.red('❌❌❌❌❌ Encountered fatal errors ❌❌❌❌❌'),
    );
  } else {
    rootLogger.info(chalk.green('✅✅✅✅✅ No fatal errors ✅✅✅✅✅'));
  }

  const chainResults = Object.fromEntries(result);
  const resultsPath = `${outputFileName}-${Date.now()}.yaml`;
  writeYaml(resultsPath, chainResults);
  rootLogger.info(`Results written to ${resultsPath}`);

  if (errors.length) {
    process.exit(1);
  }
}

export async function executePendingTransactions<T>(
  executableTxs: T[],
  txId: (tx: T) => string,
  txChain: (tx: T) => string,
  executeTx: (tx: T) => Promise<any>,
  confirmPrompt: ConfirmPrompt = (options) => confirm(options),
) {
  if (executableTxs.length === 0) {
    return;
  }

  // Ask if user wants to execute all transactions at once
  const confirmExecuteAll = await confirmPrompt({
    message: `Execute ALL ${executableTxs.length} transactions without further prompts?`,
    default: false,
  });

  const failedTransactions: Array<{
    id: string;
    chain: string;
    error: unknown;
  }> = [];

  for (const tx of executableTxs) {
    let id: string;
    let chain: string;
    try {
      id = txId(tx);
      chain = txChain(tx);
    } catch (error) {
      rootLogger.error(
        chalk.red('Error deriving pending transaction metadata:'),
        error,
      );
      failedTransactions.push({
        id: '<unknown>',
        chain: '<unknown>',
        error,
      });
      continue;
    }
    if (
      typeof id !== 'string' ||
      id.trim().length === 0 ||
      typeof chain !== 'string' ||
      chain.trim().length === 0
    ) {
      rootLogger.error(
        chalk.red(
          `Invalid pending transaction metadata: chain=${String(chain)} id=${String(id)}`,
        ),
      );
      failedTransactions.push({
        id: '<unknown>',
        chain: '<unknown>',
        error: new Error('Invalid pending transaction metadata'),
      });
      continue;
    }

    const confirmExecuteTx =
      confirmExecuteAll ||
      (await confirmPrompt({
        message: `Execute transaction ${id} on chain ${chain}?`,
        default: false,
      }));

    if (!confirmExecuteTx) {
      continue;
    }

    rootLogger.info(`Executing transaction ${id} on chain ${chain}`);
    try {
      await executeTx(tx);
    } catch (error) {
      rootLogger.error(
        chalk.red(`Error executing transaction ${id} on chain ${chain}:`),
        error,
      );
      failedTransactions.push({ id, chain, error });
      continue;
    }
  }

  if (failedTransactions.length > 0) {
    const failedTxSummary = failedTransactions
      .map(({ id, chain }) => `${chain}:${id}`)
      .join(', ');
    throw new Error(
      `Failed to execute ${failedTransactions.length} transaction(s): ${failedTxSummary}`,
    );
  }
}
