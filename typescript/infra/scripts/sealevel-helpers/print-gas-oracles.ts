import { objMap, stringifyObject } from '@hyperlane-xyz/utils';

import { getArgs } from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

// This script exists to print the chain metadata configs for a given environment
// so they can easily be copied into the Sealevel tooling. :'(

async function main() {
  const args = await getArgs().argv;

  const environmentConfig = getEnvironmentConfig(args.environment);

  // Construct a nested map of origin -> destination -> { oracleConfig, overhead }
  const gasOracles = objMap(environmentConfig.igp, (origin, igpConfig) => {
    console.log('origin', origin, 'igpConfig', igpConfig);
    let a = objMap(igpConfig.oracleConfig, (destination, oracleConfig) => {
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
    // console.log('a', a, 'origin');
    // return 'sup';
    return a;
  });

  console.log('do we get here ?');

  console.log('keys?', Object.keys(gasOracles));

  console.log(stringifyObject(gasOracles, 'yaml'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
