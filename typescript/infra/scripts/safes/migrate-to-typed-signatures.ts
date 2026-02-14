import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import yargs from 'yargs';

import {
  type SafeAndService,
  createSafeTransaction,
  createSafeTransactionData,
  deleteSafeTx,
  getPendingTxsForChains,
  getSafeAndService,
  getSafeTx,
  hasSafeServiceTransactionPayload,
  proposeSafeTransaction,
} from '@hyperlane-xyz/sdk';
import {
  LogFormat,
  LogLevel,
  assert,
  configureRootLogger,
  rootLogger,
  stringifyObject,
} from '@hyperlane-xyz/utils';

import { Contexts } from '../../config/contexts.js';
import { awSafes as safes } from '../../config/environments/mainnet3/governance/safe/aw.js';
import { Role } from '../../src/roles.js';
import { withChains } from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

async function main() {
  const safeChains = Object.keys(safes);
  configureRootLogger(LogFormat.Pretty, LogLevel.Info);
  const { chains, fullTxHash } = await withChains(
    yargs(process.argv.slice(2)),
    safeChains,
  )
    .describe(
      'fullTxHash',
      'If enabled, include the full tx hash in the output',
    )
    .boolean('fullTxHash')
    .default('fullTxHash', false).argv;

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
  const safeContextByChain = new Map<
    string,
    SafeAndService & { signer: ReturnType<typeof multiProvider.getSigner> }
  >();

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

  const shouldRepropose = await confirm({
    message: 'Repropose transactions with typed signatures?',
    default: false,
  });

  if (!shouldRepropose) {
    rootLogger.info(
      chalk.blue(`${pendingTxs.length} transactions available for reproposing`),
    );
    process.exit(0);
  }

  rootLogger.info(chalk.blueBright('Reproposing transactions...'));

  for (const tx of pendingTxs) {
    const confirmReproposeTx = await confirm({
      message: `Repropose transaction ${tx.shortTxHash} on chain ${tx.chain}?`,
      default: false,
    });
    if (confirmReproposeTx) {
      rootLogger.info(
        `Reproposing transaction ${tx.shortTxHash} on chain ${tx.chain}`,
      );
      try {
        const safeAddress = safes[tx.chain];
        assert(
          safeAddress,
          `Safe address not configured for chain ${tx.chain}`,
        );
        let safeContext = safeContextByChain.get(tx.chain);
        if (!safeContext) {
          const { safeSdk, safeService } = await getSafeAndService(
            tx.chain,
            multiProvider,
            safeAddress,
          );
          const signer = multiProvider.getSigner(tx.chain);
          safeContext = { safeSdk, safeService, signer };
          safeContextByChain.set(tx.chain, safeContext);
        }
        const { safeSdk, safeService, signer } = safeContext;

        const safeTx = await getSafeTx(tx.chain, multiProvider, tx.fullTxHash);
        assert(
          safeTx && hasSafeServiceTransactionPayload(safeTx),
          `Safe transaction ${tx.fullTxHash} on ${tx.chain} is missing to/data/value`,
        );

        // Log the transaction details
        rootLogger.info(
          chalk.gray(
            `Transaction details:\n${stringifyObject({
              to: safeTx.to,
              data: safeTx.data,
              value: safeTx.value,
            })}`,
          ),
        );

        // Delete the pending transaction
        await deleteSafeTx(tx.chain, multiProvider, safeAddress, tx.fullTxHash);

        const safeTransactionData = createSafeTransactionData(safeTx);
        const safeTransaction = await createSafeTransaction(
          safeSdk,
          [safeTransactionData],
          undefined,
          tx.nonce,
        );

        await proposeSafeTransaction(
          tx.chain,
          safeSdk,
          safeService,
          safeTransaction,
          safeAddress,
          signer,
        );

        rootLogger.info(
          chalk.green(
            `Successfully reproposed transaction ${tx.shortTxHash} on chain ${tx.chain}`,
          ),
        );
      } catch (error) {
        rootLogger.error(chalk.red(`Error reproposing transaction: ${error}`));
        continue;
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
