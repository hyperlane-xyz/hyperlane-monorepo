import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';

import { rootLogger, stringifyObject } from '@hyperlane-xyz/utils';
import { writeYaml } from '@hyperlane-xyz/utils/fs';

import { GovernTransaction } from './govern-transaction-reader.js';

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
) {
  // Ask if user wants to execute all transactions at once
  const confirmExecuteAll = await confirm({
    message: `Execute ALL ${executableTxs.length} transactions without further prompts?`,
    default: false,
  });

  for (const tx of executableTxs) {
    const id = txId(tx);
    const chain = txChain(tx);

    const confirmExecuteTx =
      confirmExecuteAll ||
      (await confirm({
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
      rootLogger.error(chalk.red(`Error executing transaction: ${error}`));
      return;
    }
  }
}
