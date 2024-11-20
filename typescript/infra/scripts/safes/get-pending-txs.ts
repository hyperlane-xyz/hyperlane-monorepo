import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import yargs from 'yargs';

import { MultiProvider } from '@hyperlane-xyz/sdk';

import { Contexts } from '../../config/contexts.js';
import { safes } from '../../config/environments/mainnet3/owners.js';
import { Role } from '../../src/roles.js';
import { executeTx, getSafeAndService } from '../../src/utils/safe.js';
import { withChains } from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

export enum SafeTxStatus {
  NO_CONFIRMATIONS = '🔴',
  PENDING = '🟡',
  ONE_AWAY = '🔵',
  READY_TO_EXECUTE = '🟢',
}

type SafeStatus = {
  chain: string;
  nonce: number;
  submissionDate: string;
  shortTxHash: string;
  fullTxHash: string;
  confs: number;
  threshold: number;
  status: string;
};

export async function getPendingTxsForChains(
  chains: string[],
  multiProvider: MultiProvider,
): Promise<SafeStatus[]> {
  const txs: SafeStatus[] = [];
  await Promise.all(
    chains.map(async (chain) => {
      if (!safes[chain]) {
        console.error(chalk.red.bold(`No safe found for ${chain}`));
        return;
      }

      if (chain === 'endurance') {
        console.info(
          chalk.gray.italic(
            `Skipping chain ${chain} as it does not have a functional safe API`,
          ),
        );
        return;
      }

      let safeSdk, safeService;
      try {
        ({ safeSdk, safeService } = await getSafeAndService(
          chain,
          multiProvider,
          safes[chain],
        ));
      } catch (error) {
        console.warn(
          chalk.yellow(
            `Skipping chain ${chain} as there was an error getting the safe service: ${error}`,
          ),
        );
        return;
      }

      const threshold = await safeSdk.getThreshold();
      const pendingTxs = await safeService.getPendingTransactions(safes[chain]);
      if (pendingTxs.results.length === 0) {
        return;
      }

      pendingTxs.results.forEach(
        ({ nonce, submissionDate, safeTxHash, confirmations }) => {
          const confs = confirmations?.length ?? 0;
          const status =
            confs >= threshold
              ? SafeTxStatus.READY_TO_EXECUTE
              : confs === 0
              ? SafeTxStatus.NO_CONFIRMATIONS
              : threshold - confs
              ? SafeTxStatus.ONE_AWAY
              : SafeTxStatus.PENDING;

          txs.push({
            chain,
            nonce,
            submissionDate: new Date(submissionDate).toDateString(),
            shortTxHash: `${safeTxHash.slice(0, 6)}...${safeTxHash.slice(-4)}`,
            fullTxHash: safeTxHash,
            confs,
            threshold,
            status,
          });
        },
      );
    }),
  );
  return txs.sort(
    (a, b) => a.chain.localeCompare(b.chain) || a.nonce - b.nonce,
  );
}

async function main() {
  const safeChains = Object.keys(safes);
  const { chains, fullTxHash, execute } = await withChains(
    yargs(process.argv.slice(2)),
    safeChains,
  )
    .describe(
      'fullTxHash',
      'If enabled, include the full tx hash in the output',
    )
    .boolean('fullTxHash')
    .default('fullTxHash', false)
    .describe(
      'execute',
      'If enabled, execute transactions that have enough confirmations',
    )
    .boolean('execute')
    .default('execute', false).argv;

  const chainsToCheck = chains || safeChains;
  if (chainsToCheck.length === 0) {
    console.error('No chains provided');
    process.exit(1);
  }

  const envConfig = getEnvironmentConfig('mainnet3');
  const multiProvider = await envConfig.getMultiProvider(
    Contexts.Hyperlane,
    Role.Deployer,
    true,
    chainsToCheck,
  );

  const pendingTxs = await getPendingTxsForChains(chainsToCheck, multiProvider);
  if (pendingTxs.length === 0) {
    console.info(chalk.green('No pending transactions found!'));
    process.exit(0);
  }
  console.table(pendingTxs, [
    'chain',
    'nonce',
    'submissionDate',
    fullTxHash ? 'fullTxHash' : 'shortTxHash',
    'confs',
    'threshold',
    'status',
  ]);

  const executableTxs = pendingTxs.filter(
    (tx) => tx.status === SafeTxStatus.READY_TO_EXECUTE,
  );
  if (
    executableTxs.length === 0 ||
    !execute ||
    !(await confirm({
      message: 'Execute transactions?',
      default: execute,
    }))
  ) {
    console.info(chalk.green('No transactions to execute!'));
    process.exit(0);
  } else {
    console.info(chalk.blueBright('Executing transactions...'));
  }

  for (const tx of executableTxs) {
    const confirmExecuteTx = await confirm({
      message: `Execute transaction ${tx.shortTxHash} on chain ${tx.chain}?`,
      default: execute,
    });
    if (confirmExecuteTx) {
      console.log(
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
        console.error(chalk.red(`Error executing transaction: ${error}`));
        return;
      }
    }
  }

  process.exit(0);
}

main()
  .then()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
