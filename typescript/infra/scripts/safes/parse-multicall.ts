import { stringifyObject, strip0x } from '@hyperlane-xyz/utils';

import { TransactionReader } from '../../src/tx/transaction-reader.js';
import { getArgs } from '../agent-utils.js';
import { getEnvironmentConfig, getHyperlaneCore } from '../core-utils.js';

import tx from './example-data.json';

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
  );
  const results = await reader.read('ethereum', tx);

  console.log('results', results);

  console.log(stringifyObject(results, 'yaml', 2));
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
