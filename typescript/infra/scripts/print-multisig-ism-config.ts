import { AllChains, IsmType } from '@hyperlane-xyz/sdk';

import { multisigIsms } from '../config/multisigIsm.js';

import { getArgs, withContext } from './agent-utils.js';

// This script exists to print the default multisig ISM validator sets for a given environment
// so they can easily be copied into the Sealevel tooling. :'(

async function main() {
  const args = await withContext(getArgs())
    .describe('local', 'local chain')
    .choices('local', AllChains)
    .demandOption('local').argv;

  const config = multisigIsms(
    args.environment,
    args.local,
    IsmType.MESSAGE_ID_MULTISIG,
    args.context,
  );

  console.log(JSON.stringify(config, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
