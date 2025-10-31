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
  getPendingProposalsForChains,
  logProposals,
} from '../../src/utils/squads.js';
import { withChains } from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

const environment = 'mainnet3';

async function main() {
  configureRootLogger(LogFormat.Pretty, LogLevel.Info);

  const { chains } = await withChains(
    yargs(process.argv.slice(2)),
    Object.keys(squadsConfigs),
  ).argv;

  const squadChains = Object.keys(squadsConfigs);
  const chainsToCheck = chains || squadChains;

  if (chainsToCheck.length === 0) {
    rootLogger.error('No chains provided');
    process.exit(1);
  }

  rootLogger.info(chalk.blue.bold('🔍 Squads Proposal Status Monitor'));
  rootLogger.info(
    chalk.blue(
      `Checking squads proposals on chains: ${chainsToCheck.join(', ')}`,
    ),
  );

  const envConfig = getEnvironmentConfig(environment);
  const mpp = await envConfig.getMultiProtocolProvider();

  const pendingProposals = await getPendingProposalsForChains(
    chainsToCheck,
    mpp,
  );

  if (pendingProposals.length === 0) {
    rootLogger.info(chalk.green('No pending proposals found!'));
    process.exit(0);
  }

  logProposals(pendingProposals);

  process.exit(0);
}

main()
  .then()
  .catch((e) => {
    rootLogger.error(e);
    process.exit(1);
  });
