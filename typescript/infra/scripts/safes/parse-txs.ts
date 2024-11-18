import { BigNumber } from 'ethers';

import { AnnotatedEV5Transaction } from '@hyperlane-xyz/sdk';
import { stringifyObject } from '@hyperlane-xyz/utils';

import { TransactionReader } from '../../src/tx/transaction-reader.js';
import { getSafeTx } from '../../src/utils/safe.js';
import {
  getArgs,
  withChainRequired,
  withChainsRequired,
  withTxHashes,
} from '../agent-utils.js';
import { getEnvironmentConfig, getHyperlaneCore } from '../core-utils.js';

async function main() {
  const { environment, chains, txHashes } = await withTxHashes(
    withChainsRequired(getArgs()),
  ).argv;

  const config = getEnvironmentConfig(environment);
  const multiProvider = await config.getMultiProvider();
  const { chainAddresses } = await getHyperlaneCore(environment, multiProvider);

  const reader = new TransactionReader(
    environment,
    multiProvider,
    chainAddresses,
    config.core,
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

      const results = await reader.read(chain, tx);
      console.log(`Completed tx ${txHash} on ${chain}`);
      return [chain, results];
    }),
  );

  const chainResults = Object.fromEntries(chainResultEntries);
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
