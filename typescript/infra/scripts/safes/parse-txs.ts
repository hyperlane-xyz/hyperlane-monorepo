import chalk from 'chalk';
import { BigNumber } from 'ethers';
import yargs from 'yargs';

import {
  AnnotatedEV5Transaction,
  getPendingTxsForChains,
  getSafeTx,
  hasSafeServiceTransactionPayload,
} from '@hyperlane-xyz/sdk';
import {
  LogFormat,
  LogLevel,
  assert,
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

  const parseResults = await Promise.all(
    pendingTxs.map(
      async ({
        chain,
        nonce,
        fullTxHash,
      }): Promise<
        | { success: [string, GovernTransaction] }
        | { failure: { chain: string; fullTxHash: string } }
      > => {
        rootLogger.info(
          chalk.gray.italic(`Reading tx ${fullTxHash} on ${chain}`),
        );
        try {
          const safeTx = await getSafeTx(chain, multiProvider, fullTxHash);
          assert(
            hasSafeServiceTransactionPayload(safeTx),
            `Safe transaction ${fullTxHash} on ${chain} is missing to/data/value`,
          );
          const tx: AnnotatedEV5Transaction = {
            to: safeTx.to,
            data: safeTx.data,
            value: BigNumber.from(safeTx.value),
          };
          const results = await reader.read(chain, tx);
          rootLogger.info(
            chalk.blue(`Finished reading tx ${fullTxHash} on ${chain}`),
          );
          return { success: [`${chain}-${nonce}-${fullTxHash}`, results] };
        } catch (err) {
          rootLogger.error(
            chalk.red(
              `Error reading transaction ${fullTxHash} on ${chain}: ${err}`,
            ),
          );
          return { failure: { chain, fullTxHash } };
        }
      },
    ),
  );

  const chainResultEntries = parseResults
    .map((result) => ('success' in result ? result.success : undefined))
    .filter((result): result is [string, GovernTransaction] => !!result);
  const failedTxReads = parseResults
    .map((result) => ('failure' in result ? result.failure : undefined))
    .filter(
      (
        result,
      ): result is {
        chain: string;
        fullTxHash: string;
      } => !!result,
    );

  processGovernorReaderResult(
    chainResultEntries,
    reader.errors,
    'safe-tx-parse-results',
  );

  if (failedTxReads.length > 0) {
    rootLogger.error(
      chalk.red(
        `Failed to parse ${failedTxReads.length} Safe transaction(s). See logs above for details.`,
      ),
    );
    process.exit(1);
  }
}

main().catch((err) => {
  rootLogger.error('Error:', err);
  process.exit(1);
});
