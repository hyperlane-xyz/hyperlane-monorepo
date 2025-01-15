import { objMap, stringifyObject } from '@hyperlane-xyz/utils';

import { writeJsonAtPath } from '../../src/utils/utils.js';
import { getArgs, withOutFile } from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

// This script exists to print the chain metadata configs for a given environment
// so they can easily be copied into the Sealevel tooling. :'(

async function main() {
  const { environment, outFile } = await withOutFile(getArgs()).argv;

  const environmentConfig = getEnvironmentConfig(environment);

  // Construct a nested map of origin -> destination -> { oracleConfig, overhead }
  const gasOracles = objMap(environmentConfig.igp, (origin, igpConfig) => {
    console.log('origin', origin, 'igpConfig', igpConfig);
    if (!igpConfig.oracleConfig) {
      return {};
    }
    return objMap(igpConfig.oracleConfig, (destination, oracleConfig) => {
      console.log('origin', origin, 'destination', destination);
      console.log(
        'oracleConfig',
        oracleConfig,
        'overhead',
        igpConfig?.overhead?.[destination],
      );
      return {
        oracleConfig,
        overhead: igpConfig?.overhead?.[destination],
      };
    });
  });

  console.log('do we get here ?');

  console.log('keys?', stringifyObject(Object.keys(gasOracles)));

  console.log(stringifyObject(gasOracles, 'yaml'));

  if (outFile) {
    console.log(`Writing config to ${outFile}`);
    writeJsonAtPath(outFile, gasOracles);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
