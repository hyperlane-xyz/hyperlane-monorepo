import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import yargs from 'yargs';

import {
  LogFormat,
  LogLevel,
  configureRootLogger,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { Contexts } from '../../config/contexts.js';
import { getGovernanceTimelocks } from '../../config/environments/mainnet3/governance/utils.js';
import { withGovernanceType } from '../../src/governance.js';
import { Role } from '../../src/roles.js';
import {
  TimelockOperationStatus,
  getTimelockPendingTxs,
} from '../../src/utils/timelock.js';
import { withChains } from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

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

  const envConfig = getEnvironmentConfig('mainnet3');
  const multiProvider = await envConfig.getMultiProvider(
    Contexts.Hyperlane,
    Role.Deployer,
    true,
    chainsToCheck,
  );

  const pendingTxs = await getTimelockPendingTxs(
    chainsToCheck,
    multiProvider,
    timelocks,
  );
  if (pendingTxs.length === 0) {
    rootLogger.info(chalk.green('No pending transactions found!'));
    process.exit(0);
  }
  // eslint-disable-next-line no-console
  console.table(pendingTxs, [
    'chain',
    'id',
    'predecessorId',
    'status',
    'canSignerExecute',
  ]);

  const executableTxs = pendingTxs.filter(
    (tx) =>
      tx.status === TimelockOperationStatus.READY_TO_EXECUTE &&
      tx.canSignerExecute,
  );
  if (executableTxs.length === 0) {
    rootLogger.info(chalk.green('No transactions to execute!'));
    process.exit(0);
  }

  const shouldExecute = await confirm({
    message: 'Execute transactions?',
    default: false,
  });

  if (!shouldExecute) {
    rootLogger.info(
      chalk.blue(
        `${executableTxs.length} transactions available for execution`,
      ),
    );
    process.exit(0);
  }

  rootLogger.info(chalk.blueBright('Executing transactions...'));
  for (const tx of executableTxs) {
    const confirmExecuteTx = await confirm({
      message: `Execute transaction ${tx.id} on chain ${tx.chain}?`,
      default: false,
    });

    if (!confirmExecuteTx) {
      continue;
    }

    rootLogger.info(`Executing transaction ${tx.id} on chain ${tx.chain}`);
    try {
      await multiProvider.sendTransaction(tx.chain, {
        to: tx.timelockAddress,
        data: tx.executeTransactionData,
      });
    } catch (error) {
      rootLogger.error(chalk.red(`Error executing transaction: ${error}`));
      return;
    }
  }

  process.exit(0);
}

main()
  .then()
  .catch((e) => {
    rootLogger.error(e);
    process.exit(1);
  });
