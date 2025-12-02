import chalk from 'chalk';
import yargs from 'yargs';

import {
  LogFormat,
  LogLevel,
  configureRootLogger,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { squadsConfigs } from '../../src/config/squads.js';
import {
  SquadsTransaction,
  SquadsTransactionReader,
} from '../../src/tx/squads-transaction-reader.js';
import { processGovernorReaderResult } from '../../src/tx/utils.js';
import {
  getPendingProposalsForChains,
  logProposals,
} from '../../src/utils/squads.js';
import { withChains } from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

const environment = 'mainnet3';

async function main() {
  const { chains } = await withChains(
    yargs(process.argv.slice(2)),
    Object.keys(squadsConfigs),
  ).argv;
  configureRootLogger(LogFormat.Pretty, LogLevel.Info);

  // Get the multiprovider for the environment
  const config = getEnvironmentConfig(environment);
  const mpp = await config.getMultiProtocolProvider();

  // Initialize the transaction reader
  const reader = new SquadsTransactionReader(environment, mpp);

  // Get the pending proposals for the relevant chains
  const chainsToCheck =
    !chains || chains.length === 0 ? Object.keys(squadsConfigs) : chains;

  const pendingProposals = await getPendingProposalsForChains(
    chainsToCheck,
    mpp,
  );

  if (pendingProposals.length === 0) {
    rootLogger.info(chalk.green('No pending proposals found!'));
    process.exit(0);
  }

  logProposals(pendingProposals);

  // Parse each proposal and collect results
  const chainResultEntries = await Promise.all(
    pendingProposals.map(
      async ({
        chain,
        nonce,
        fullTxHash,
      }): Promise<[string, SquadsTransaction]> => {
        rootLogger.info(
          chalk.gray.italic(
            `Parsing proposal ${nonce} (${fullTxHash}) on ${chain}...`,
          ),
        );

        try {
          const result = await reader.read(chain, nonce);
          rootLogger.info(
            chalk.blue(`Finished parsing proposal ${nonce} on ${chain}`),
          );
          return [`${chain}-${nonce}-${fullTxHash}`, result];
        } catch (error) {
          rootLogger.error(
            chalk.red(`Error parsing proposal ${nonce} on ${chain}:`),
            error,
          );
          return [`${chain}-${nonce}-${fullTxHash}`, { chain, error }];
        }
      },
    ),
  );

  // Process results and write to file
  processGovernorReaderResult(
    chainResultEntries,
    reader.errors,
    'squads-tx-parse-results',
  );
}

main().catch((err) => {
  rootLogger.error('Error:', err);
  process.exit(1);
});
