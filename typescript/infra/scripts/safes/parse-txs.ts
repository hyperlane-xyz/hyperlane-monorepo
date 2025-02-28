import chalk from 'chalk';
import { BigNumber } from 'ethers';
import yargs from 'yargs';

import { AnnotatedEV5Transaction } from '@hyperlane-xyz/sdk';
import {
  LogFormat,
  LogLevel,
  configureRootLogger,
  rootLogger,
  stringifyObject,
} from '@hyperlane-xyz/utils';

import { safes } from '../../config/environments/mainnet3/owners.js';
import { GovernTransactionReader } from '../../src/tx/govern-transaction-reader.js';
import { getPendingTxsForChains, getSafeTx } from '../../src/utils/safe.js';
import { writeYamlAtPath } from '../../src/utils/utils.js';
import { withChains } from '../agent-utils.js';
import { getEnvironmentConfig, getHyperlaneCore } from '../core-utils.js';

const environment = 'mainnet3';
const safeChains = Object.keys(safes);

async function main() {
  const { chains } = await withChains(yargs(process.argv.slice(2)), safeChains)
    .argv;
  configureRootLogger(LogFormat.Pretty, LogLevel.Info);

  const config = getEnvironmentConfig(environment);
  const multiProvider = await config.getMultiProvider();
  const { chainAddresses } = await getHyperlaneCore(environment, multiProvider);

  const registry = await config.getRegistry();
  const warpRoutes = await registry.getWarpRoutes();

  const reader = new GovernTransactionReader(
    environment,
    multiProvider,
    chainAddresses,
    config.core,
    warpRoutes,
  );

  const pendingTxs = await getPendingTxsForChains(
    !chains || chains.length === 0 ? safeChains : chains,
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
    'fullTxHash',
    'confs',
    'threshold',
    'status',
    'balance',
  ]);

  const chainResultEntries = await Promise.all(
    pendingTxs.map(async ({ chain, nonce, fullTxHash }) => {
      rootLogger.info(`Reading tx ${fullTxHash} on ${chain}`);
      const safeTx = await getSafeTx(chain, multiProvider, fullTxHash);
      const tx: AnnotatedEV5Transaction = {
        to: safeTx.to,
        data: safeTx.data,
        value: BigNumber.from(safeTx.value),
      };

      try {
        const results = await reader.read(chain, tx);
        rootLogger.info(`Finished reading tx ${fullTxHash} on ${chain}`);
        return [`${chain}-${nonce}-${fullTxHash}`, results];
      } catch (err) {
        rootLogger.error('Error reading transaction', err, chain, tx);
        process.exit(1);
      }
    }),
  );

  if (reader.errors.length) {
    rootLogger.error('❌❌❌❌❌ Encountered fatal errors ❌❌❌❌❌');
    rootLogger.info(stringifyObject(reader.errors, 'yaml', 2));
    rootLogger.error('❌❌❌❌❌ Encountered fatal errors ❌❌❌❌❌');
    process.exit(1);
  } else {
    rootLogger.info('✅✅✅✅✅ No fatal errors ✅✅✅✅✅');
    const chainResults = Object.fromEntries(chainResultEntries);
    const resultsPath = `safe-tx-results-${Date.now()}.yaml`;
    writeYamlAtPath(resultsPath, chainResults);
    rootLogger.info(`Results written to ${resultsPath}`);
  }
}

main().catch((err) => {
  rootLogger.error('Error:', err);
  process.exit(1);
});
