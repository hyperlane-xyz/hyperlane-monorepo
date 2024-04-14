import { getArgs } from './agent-utils.js';
import { getEnvironmentConfig } from './core-utils.js';

// This script exists to print the chain metadata configs for a given environment
// so they can easily be copied into the Sealevel tooling. :'(

async function main() {
  const args = await getArgs().argv;

  const environmentConfig = getEnvironmentConfig(args.environment);

  console.log(JSON.stringify(environmentConfig.chainMetadataConfigs, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
