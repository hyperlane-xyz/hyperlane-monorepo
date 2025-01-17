import { objMap, stringifyObject } from '@hyperlane-xyz/utils';

import { writeJsonAtPath } from '../../src/utils/utils.js';
import { getArgs, withOutFile } from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

// This script exists to print the gas oracle configs for a given environment
// so they can easily be copied into the Sealevel tooling. :'(

async function main() {
  const { environment, outFile } = await withOutFile(getArgs()).argv;

  const environmentConfig = getEnvironmentConfig(environment);

  // Construct a nested map of origin -> destination -> { oracleConfig, overhead }
  const gasOracles = objMap(environmentConfig.igp, (origin, igpConfig) => {
    // If there's no oracle config, don't do anything for this origin
    if (!igpConfig.oracleConfig) {
      return {};
    }
    return objMap(igpConfig.oracleConfig, (destination, oracleConfig) => ({
      oracleConfig,
      overhead: igpConfig?.overhead?.[destination],
    }));
  });

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
