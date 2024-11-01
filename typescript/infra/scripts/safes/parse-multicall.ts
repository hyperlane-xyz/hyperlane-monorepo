import { stringifyObject } from '@hyperlane-xyz/utils';

import { TransactionReader } from '../../src/tx/transaction-reader.js';
import { getArgs } from '../agent-utils.js';
import { getEnvironmentConfig, getHyperlaneCore } from '../core-utils.js';

import tx from './ethereum-safe-tx-oct-30.json';

async function main() {
  const { environment } = await getArgs().argv;
  const config = getEnvironmentConfig(environment);
  const multiProvider = await config.getMultiProvider();
  const { chainAddresses } = await getHyperlaneCore(environment, multiProvider);

  const reader = new TransactionReader(
    environment,
    multiProvider,
    'ethereum',
    chainAddresses,
    config.core,
  );
  const results = await reader.read('ethereum', tx);

  console.log(stringifyObject(results, 'yaml', 2));

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
