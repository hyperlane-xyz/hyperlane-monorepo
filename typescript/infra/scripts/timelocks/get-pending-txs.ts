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
import { executePendingTransactions } from '../../src/tx/utils.js';
import { logTable } from '../../src/utils/log.js';
import {
  TimelockOperationStatus,
  getPendingTimelockTxs,
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

  const pendingTxs = await getPendingTimelockTxs(
    chainsToCheck,
    multiProvider,
    timelocks,
  );
  if (pendingTxs.length === 0) {
    rootLogger.info(chalk.green('No pending transactions found!'));
    process.exit(0);
  }

  // Sort by chain name, then by earliestExecution (as BigNumber, so use .toNumber())
  // Then convert earliestExecution to a readable date string
  logTable(
    pendingTxs
      .sort((a, b) => {
        const chainCmp = a.chain.localeCompare(b.chain);
        if (chainCmp !== 0) return chainCmp;
        // Compare earliestExecution as numbers (BigNumber -> number)
        const aExec = a.earliestExecution.toNumber();
        const bExec = b.earliestExecution.toNumber();
        return aExec - bExec;
      })
      .map((tx) => ({
        ...tx,
        earliestExecution: new Date(
          tx.earliestExecution.toNumber() * 1000,
        ).toLocaleString(),
      })),
    ['chain', 'id', 'earliestExecution', 'status'],
  );

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
  await executePendingTransactions(
    executableTxs,
    (tx) => tx.id,
    (tx) => tx.chain,
    (tx) =>
      multiProvider.sendTransaction(tx.chain, {
        to: tx.timelockAddress,
        data: tx.executeTransactionData,
      }),
  );

  process.exit(0);
}

main()
  .then()
  .catch((e) => {
    rootLogger.error(e);
    process.exit(1);
  });
