import chalk from 'chalk';
import { BigNumber } from 'ethers';
import yargs from 'yargs';

import { AnnotatedEV5Transaction } from '@hyperlane-xyz/sdk';
import {
  LogFormat,
  LogLevel,
  configureRootLogger,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { getGovernanceSafes } from '../../config/environments/mainnet3/governance/utils.js';
import { withGovernanceType } from '../../src/governance.js';
import {
  GovernTransaction,
  GovernTransactionReader,
} from '../../src/tx/govern-transaction-reader.js';
import { processGovernorReaderResult } from '../../src/tx/utils.js';
import { logTable } from '../../src/utils/log.js';
import { getPendingTxsForChains, getSafeTx } from '../../src/utils/safe.js';
import { withChains } from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

const environment = 'mainnet3';

async function main() {
  const { chains, governanceType } = await withGovernanceType(
    withChains(yargs(process.argv.slice(2))),
  ).argv;
  configureRootLogger(LogFormat.Pretty, LogLevel.Info);

  // Get the multiprovider for the environment
  const config = getEnvironmentConfig(environment);
  const multiProvider = await config.getMultiProvider();

  // Get the relevant set of governance safes and icas
  const safes = getGovernanceSafes(governanceType);

  // Initialize the transaction reader for the given governance type
  const reader = await GovernTransactionReader.create(
    environment,
    governanceType,
  );

  // Get the pending transactions for the relevant chains, for the chosen governance type
  const pendingTxs = await getPendingTxsForChains(
    !chains || chains.length === 0 ? Object.keys(safes) : chains,
    multiProvider,
    safes,
  );
  if (pendingTxs.length === 0) {
    rootLogger.info(chalk.green('No pending transactions found!'));
    process.exit(0);
  }

  logTable(pendingTxs, [
    'chain',
    'nonce',
    'submissionDate',
    'fullTxHash',
    'confs',
    'threshold',
    'status',
    'balance',
  ]);

  const chainResultEntries = await Promise.all(
    pendingTxs.map(
      async ({
        chain,
        nonce,
        fullTxHash,
      }): Promise<[string, GovernTransaction]> => {
        rootLogger.info(
          chalk.gray.italic(`Reading tx ${fullTxHash} on ${chain}`),
        );
        const safeTx = await getSafeTx(chain, multiProvider, fullTxHash);
        const tx: AnnotatedEV5Transaction = {
          to: safeTx.to,
          data: safeTx.data,
          value: BigInt(safeTx.value),
        };

        try {
          const results = await reader.read(chain, tx);
          rootLogger.info(
            chalk.blue(`Finished reading tx ${fullTxHash} on ${chain}`),
          );
          return [`${chain}-${nonce}-${fullTxHash}`, results];
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
    'safe-tx-parse-results',
  );
}

main().catch((err) => {
  rootLogger.error('Error:', err);
  process.exit(1);
});
