import { normalizeConfig } from '@hyperlane-xyz/sdk';
import { stringifyObject, strip0x } from '@hyperlane-xyz/utils';

import { TransactionReader } from '../../src/tx/transaction-reader.js';
import { readYaml } from '../../src/utils/utils.js';
import { getArgs } from '../agent-utils.js';
import { getEnvironmentConfig, getHyperlaneCore } from '../core-utils.js';

import tx from './example-data.json';

async function main() {
  const { environment } = await getArgs().argv;
  const config = getEnvironmentConfig(environment);
  const multiProvider = await config.getMultiProvider();
  const { chainAddresses } = await getHyperlaneCore(environment, multiProvider);

  // const yaml: any = readYaml('/Users/trevor/example-mismatch.yaml');
  // const mismatch = yaml[0];
  // const normalizedDerived = normalizeConfig(mismatch.derivedConfig);
  // const normalizedExpected = normalizeConfig(mismatch.expectedIsmConfig);
  // console.log('\n\n\n\n\n\nDerived:', stringifyObject(normalizedDerived, 'yaml', 2));
  // console.log('\n\n\n\n\n\nExpected:', stringifyObject(normalizedExpected, 'yaml', 2));

  // return;

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
