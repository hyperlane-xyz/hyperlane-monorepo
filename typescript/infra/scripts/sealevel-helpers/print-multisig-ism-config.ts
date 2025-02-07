import { IsmType } from '@hyperlane-xyz/sdk';

import { multisigIsms } from '../../config/multisigIsm.js';
import { getChains } from '../../config/registry.js';
import { getArgs, withContext } from '../agent-utils.js';

// This script exists to print the default multisig ISM validator sets for a given environment
// so they can easily be copied into the Sealevel tooling. :'(

async function main() {
  const args = await withContext(getArgs())
    .describe('local', 'local chain')
    .choices('local', getChains())
    .demandOption('local').argv;

  const config = multisigIsms(
    args.environment,
    args.local,
    IsmType.MESSAGE_ID_MULTISIG,
    args.context,
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
    if (config[chain].threshold > MAX_THRESHOLD) {
      console.warn(
        `Threshold for ${chain} is ${config[chain].threshold}. Capping to ${MAX_THRESHOLD}.`,
      );
      config[chain].threshold = MAX_THRESHOLD;
    }
  }

  console.log(JSON.stringify(config, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
