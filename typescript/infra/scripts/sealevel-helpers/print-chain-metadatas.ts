import { pick } from '@hyperlane-xyz/utils';

import { getArgs } from '../agent-utils.js';
import { getEnvironmentConfig } from '../core-utils.js';

// This script exists to print the chain metadata configs for a given environment
// so they can easily be copied into the Sealevel tooling. :'(

async function main() {
  const args = await getArgs().argv;

  const environmentConfig = getEnvironmentConfig(args.environment);

  // Intentionally do not include any secrets in the output
  const registry = await environmentConfig.getRegistry(false);
  const allMetadata = await registry.getMetadata();
  const environmentMetadata = pick(
    allMetadata,
    environmentConfig.supportedChainNames,
  );

  console.log(JSON.stringify(environmentMetadata, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
