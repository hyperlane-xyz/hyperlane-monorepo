import path from 'path';

import { ChainName, IsmType } from '@hyperlane-xyz/sdk';

import { Contexts } from '../../config/contexts.js';
import { multisigIsms } from '../../config/multisigIsm.js';
import { getChains } from '../../config/registry.js';
import { DeployEnvironment } from '../../src/config/environment.js';
import {
  getMonorepoRoot,
  writeAndFormatJsonAtPath,
} from '../../src/utils/utils.js';
import { getArgs, withContext, withWrite } from '../agent-utils.js';

// This script exists to print the default multisig ISM validator sets for a given environment
// so they can easily be copied into the Sealevel tooling. :'(

const multisigIsmConfigPath = (
  environment: DeployEnvironment,
  context: Contexts,
  local: ChainName,
) =>
  path.resolve(
    getMonorepoRoot(),
    `rust/sealevel/environments/${environment}/multisig-ism-message-id/${local}/${context}/multisig-config.json`,
  );

async function main() {
  const { environment, local, context, write } = await withWrite(
    withContext(getArgs()),
  )
    .describe('local', 'local chain')
    .choices('local', getChains())
    .demandOption('local').argv;

  const config = multisigIsms(
    environment,
    local,
    IsmType.MESSAGE_ID_MULTISIG,
    context,
  );

  // Cap any thresholds to 4 due to the Sealevel transaction size limit.
  // Any higher than 4 at the moment will cause warp route synthetic deliveries to fail.
  // Example message Solana -> Eclipse that mints a synthetic:
  // https://explorer.eclipse.xyz/tx/3wcMvqZZjQon9o8nD49e3ci16AUJopZRLAfsAfs16ZrxgoNLoboNvrbV1hQHbnN3KXrWSqHmKnmM28mUvh5Un5Hd/inspect.
  // At the time, the Solana threshold was 3. Taking the max tx size of 1232 and the tx's size 1121,
  // we can find the number of additional signatures to be: floor((1232 - 1121)/65) = floor(1.707) = 1.
  // So the total number of signatures is 3 + 1 = 4.

  const MAX_THRESHOLD = 4;

  for (const chain of Object.keys(config)) {
    // exclude forma as it's not a core chain
    if (chain === 'forma') {
      continue;
    }

    if (config[chain].threshold > MAX_THRESHOLD) {
      console.warn(
        `Threshold for ${chain} is ${config[chain].threshold}. Capping to ${MAX_THRESHOLD}.`,
      );
      config[chain].threshold = MAX_THRESHOLD;
    }
  }

  if (write) {
    const filepath = multisigIsmConfigPath(environment, context, local);
    console.log(`Writing config to ${filepath}`);
    writeAndFormatJsonAtPath(filepath, config);
  } else {
    console.log(JSON.stringify(config, null, 2));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
