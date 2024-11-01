import { stringifyObject, strip0x } from '@hyperlane-xyz/utils';

import { GnosisMultisendReader } from '../../src/tx/transaction-reader.js';
import { getArgs } from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

import tx from './example-data.json';

async function main() {
  const { environment } = await getArgs().argv;
  const config = getEnvironmentConfig(environment);
  const multiProvider = await config.getMultiProvider();

  const multisendReader = new GnosisMultisendReader(multiProvider);
  // const results = await multisendReader.read(tx);

  console.log(stringifyObject(results, 'yaml', 2));
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
