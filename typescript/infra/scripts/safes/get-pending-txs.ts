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
import { getGovernanceSafes } from '../../config/environments/mainnet3/governance/utils.js';
import { withGovernanceType } from '../../src/governance.js';
import { Role } from '../../src/roles.js';
import {
  SafeTxStatus,
  executeTx,
  getPendingTxsForChains,
} from '../../src/utils/safe.js';
import { withChains } from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

async function main() {
  configureRootLogger(LogFormat.Pretty, LogLevel.Info);

  const { chains, fullTxHash, governanceType } = await withGovernanceType(
    withChains(yargs(process.argv.slice(2))),
  )
    .describe(
      'fullTxHash',
      'If enabled, include the full tx hash in the output',
    )
    .boolean('fullTxHash')
    .default('fullTxHash', false).argv;

  const safes = getGovernanceSafes(governanceType);
  const safeChains = Object.keys(safes);

  const chainsToCheck = chains || safeChains;
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

  const pendingTxs = await getPendingTxsForChains(
    chainsToCheck,
    multiProvider,
    safes,
  );
  if (pendingTxs.length === 0) {
    rootLogger.info(chalk.green('No pending transactions found!'));
    process.exit(0);
  }
  // eslint-disable-next-line no-console
  console.table(pendingTxs, [
    'chain',
    'nonce',
    'submissionDate',
    fullTxHash ? 'fullTxHash' : 'shortTxHash',
    'confs',
    'threshold',
    'status',
    'balance',
  ]);

  const executableTxs = pendingTxs.filter(
    (tx) => tx.status === SafeTxStatus.READY_TO_EXECUTE,
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
      message: `Execute transaction ${tx.shortTxHash} on chain ${tx.chain}?`,
      default: false,
    });
    if (confirmExecuteTx) {
      rootLogger.info(
        `Executing transaction ${tx.shortTxHash} on chain ${tx.chain}`,
      );
      try {
        await executeTx(
          tx.chain,
          multiProvider,
          safes[tx.chain],
          tx.fullTxHash,
        );
      } catch (error) {
        rootLogger.error(chalk.red(`Error executing transaction: ${error}`));
        return;
      }
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
