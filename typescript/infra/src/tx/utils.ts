import chalk from 'chalk';

import { rootLogger, stringifyObject } from '@hyperlane-xyz/utils';

import { writeYamlAtPath } from '../utils/utils.js';

import { GovernTransaction } from './govern-transaction-reader.js';

export function processGovernorReaderResult(
  result: [string, GovernTransaction][],
  errors: any[],
  outputFileName: string,
) {
  if (errors.length) {
    rootLogger.error(
      chalk.red('❌❌❌❌❌ Encountered fatal errors ❌❌❌❌❌'),
    );
    rootLogger.info(stringifyObject(errors, 'yaml', 2));
    rootLogger.error(
      chalk.red('❌❌❌❌❌ Encountered fatal errors ❌❌❌❌❌'),
    );
  } else {
    rootLogger.info(chalk.green('✅✅✅✅✅ No fatal errors ✅✅✅✅✅'));
  }

  const chainResults = Object.fromEntries(result);
  const resultsPath = `${outputFileName}-${Date.now()}.yaml`;
  writeYamlAtPath(resultsPath, chainResults);
  rootLogger.info(`Results written to ${resultsPath}`);

  if (errors.length) {
    process.exit(1);
  }
}
