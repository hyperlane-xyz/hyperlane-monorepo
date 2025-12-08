import chalk from 'chalk';
import yargs from 'yargs';

import { AnnotatedEV5Transaction } from '@hyperlane-xyz/sdk';
import {
  LogFormat,
  LogLevel,
  configureRootLogger,
  rootLogger,
  stringifyObject,
} from '@hyperlane-xyz/utils';

import { getGovernanceTimelocks } from '../../config/environments/mainnet3/governance/utils.js';
import { withGovernanceType } from '../../src/governance.js';
import {
  GovernTransaction,
  GovernTransactionReader,
} from '../../src/tx/govern-transaction-reader.js';
import { processGovernorReaderResult } from '../../src/tx/utils.js';
import { logTable } from '../../src/utils/log.js';
import { getPendingTimelockTxs } from '../../src/utils/timelock.js';
import { withChains } from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

const environment = 'mainnet3';

async function main() {
  configureRootLogger(LogFormat.Pretty, LogLevel.Info);
  const { chains, governanceType } = await withGovernanceType(
    withChains(yargs(process.argv.slice(2))),
  ).argv;

  const timelocks = getGovernanceTimelocks(governanceType);
  const timelockChains = Object.keys(timelocks);

  const chainsToCheck = chains || timelockChains;
  if (chainsToCheck.length === 0) {
    rootLogger.error('No chains provided');
    process.exit(1);
  }

  // Get the multiprovider for the environment
  const config = getEnvironmentConfig(environment);
  const multiProvider = await config.getMultiProvider();

  // Initialize the transaction reader for the given governance type
  const reader = await GovernTransactionReader.create(
    environment,
    governanceType,
  );

  // Get the pending transactions for the relevant chains, for the chosen governance type
  const pendingTxs = await getPendingTimelockTxs(
    chainsToCheck,
    multiProvider,
    timelocks,
  );
  if (pendingTxs.length === 0) {
    rootLogger.info(chalk.green('No pending transactions found!'));
    process.exit(0);
  }

  logTable(pendingTxs, [
    'chain',
    'id',
    'predecessorId',
    'salt',
    'status',
    'canSignerExecute',
  ]);

  const chainResultEntries = await Promise.all(
    pendingTxs.map(
      async ({
        chain,
        timelockAddress,
        executeTransactionData,
        id,
        salt,
      }): Promise<[string, GovernTransaction]> => {
        rootLogger.info(chalk.gray.italic(`Reading tx ${id} on ${chain}`));
        const tx: AnnotatedEV5Transaction = {
          to: timelockAddress,
          data: executeTransactionData,
        };

        try {
          const results = await reader.read(chain, tx);
          rootLogger.info(chalk.blue(`Finished reading tx ${id} on ${chain}`));
          return [`${chain}-${salt}-${id}`, results];
        } catch (err) {
          rootLogger.error(
            chalk.red('Error reading transaction', err, chain, tx),
          );
          process.exit(1);
        }
      },
    ),
  );

  processGovernorReaderResult(
    chainResultEntries,
    reader.errors,
    'timelock-tx-parse-result',
  );
}

main().catch((err) => {
  rootLogger.error('Error:', err);
  process.exit(1);
});
