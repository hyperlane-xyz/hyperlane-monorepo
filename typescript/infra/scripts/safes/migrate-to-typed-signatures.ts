import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import yargs from 'yargs';

import {
  LogFormat,
  LogLevel,
  assert,
  configureRootLogger,
  eqAddress,
  rootLogger,
  stringifyObject,
} from '@hyperlane-xyz/utils';

import { Contexts } from '../../config/contexts.js';
import { awSafes as safes } from '../../config/environments/mainnet3/governance/safe/aw.js';
import { Role } from '../../src/roles.js';
import {
  deleteSafeTx,
  getPendingTxsForChains,
  getSafeAndService,
  retrySafeApi,
  toProtocolKitTransaction,
} from '../../src/utils/safe.js';
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

  let failed = false;
  for (const tx of pendingTxs) {
    const confirmReproposeTx = await confirm({
      message: `Repropose transaction ${tx.shortTxHash} on chain ${tx.chain}?`,
      default: false,
    });
    if (confirmReproposeTx) {
      rootLogger.info(
        `Reproposing transaction ${tx.shortTxHash} on chain ${tx.chain}`,
      );
      let originalCleared = false;
      try {
        const { safeSdk, safeService, queueService } = await getSafeAndService(
          tx.chain,
          multiProvider,
          safes[tx.chain],
        );

        const service = queueService ?? safeService;
        const safeTx = await retrySafeApi(async () =>
          service.getTransaction(tx.fullTxHash),
        );
        assert(
          safeTx,
          `Safe transaction ${tx.fullTxHash} not found on ${tx.chain}`,
        );
        assert(
          eqAddress(safeTx.safe, safes[tx.chain]),
          `Transaction ${tx.fullTxHash} belongs to a different Safe`,
        );

        // Build and sign the exact replacement before deleting the old proposal.
        const safeTransaction = toProtocolKitTransaction(safeTx);
        const safeTxHash = await safeSdk.getTransactionHash(safeTransaction);
        assert(
          safeTxHash.toLowerCase() === tx.fullTxHash.toLowerCase(),
          `Safe transaction hash mismatch for ${tx.fullTxHash}`,
        );
        const senderSignature = await safeSdk.signTypedData(safeTransaction);
        const senderAddress = await multiProvider.getSignerAddress(tx.chain);

        rootLogger.info(
          chalk.gray(
            `Reproposal data for ${safeTxHash} on ${tx.chain}:\n${stringifyObject(
              {
                safeAddress: safes[tx.chain],
                ...safeTransaction.data,
              },
            )}`,
          ),
        );
        originalCleared = await deleteSafeTx(
          tx.chain,
          multiProvider,
          safes[tx.chain],
          tx.fullTxHash,
        );
        assert(
          originalCleared,
          `Could not delete transaction ${tx.fullTxHash}`,
        );

        await retrySafeApi(() =>
          service.proposeTransaction({
            safeAddress: safes[tx.chain],
            safeTransactionData: safeTransaction.data,
            safeTxHash,
            senderAddress,
            senderSignature: senderSignature.data,
          }),
        );

        rootLogger.info(
          chalk.green(
            `Successfully reproposed transaction ${tx.shortTxHash} on chain ${tx.chain}`,
          ),
        );
      } catch (error) {
        const reason = originalCleared
          ? 'Original proposal cleared, replacement failed'
          : 'Failed to repropose';
        rootLogger.error(
          chalk.red(`${reason} for ${tx.fullTxHash} on ${tx.chain}: ${error}`),
        );
        failed = true;
      }
    }
  }

  process.exitCode = failed ? 1 : 0;
}

main()
  .then()
  .catch((e) => {
    rootLogger.error(e);
    process.exit(1);
  });
