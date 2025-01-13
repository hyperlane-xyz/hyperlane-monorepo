import { BigNumber } from 'ethers';

import { AnnotatedEV5Transaction } from '@hyperlane-xyz/sdk';
import {
  LogFormat,
  LogLevel,
  configureRootLogger,
  stringifyObject,
} from '@hyperlane-xyz/utils';

import { GovernTransactionReader } from '../../src/tx/govern-transaction-reader.js';
import { getSafeTx } from '../../src/utils/safe.js';
import { getArgs, withChainsRequired, withTxHashes } from '../agent-utils.js';
import { getEnvironmentConfig, getHyperlaneCore } from '../core-utils.js';

async function main() {
  const { environment, chains, txHashes } = await withTxHashes(
    withChainsRequired(getArgs(), undefined, true),
  ).argv;

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

  const chainResultEntries = await Promise.all(
    chains.map(async (chain, chainIndex) => {
      const txHash = txHashes[chainIndex];
      console.log(`Reading tx ${txHash} on ${chain}`);
      const safeTx = await getSafeTx(chain, multiProvider, txHash);
      const tx: AnnotatedEV5Transaction = {
        to: safeTx.to,
        data: safeTx.data,
        value: BigNumber.from(safeTx.value),
      };

      try {
        const results = await reader.read(chain, tx);
        console.log(`Finished reading tx ${txHash} on ${chain}`);
        return { chain, results };
      } catch (err) {
        console.error('Error reading transaction', err, chain, tx);
        process.exit(1);
      }
    }),
  );

  // Just in case there are multiple results per chain, make the entries an array.
  const chainResults = chainResultEntries.reduce(
    (acc: any, { chain, results }) => {
      if (!acc[chain]) {
        acc[chain] = [];
      }
      acc[chain].push(results);
      return acc;
    },
    {},
  );

  console.log(stringifyObject(chainResults, 'yaml', 2));

  if (reader.errors.length) {
    console.error('❌❌❌❌❌ Encountered fatal errors ❌❌❌❌❌');
    console.log(stringifyObject(reader.errors, 'yaml', 2));
    console.error('❌❌❌❌❌ Encountered fatal errors ❌❌❌❌❌');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
