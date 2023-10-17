import { AllChains, ModuleType } from '@hyperlane-xyz/sdk';

import { multisigIsms } from '../config/multisigIsm';

import { getArgs, withContext } from './utils';

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
    ModuleType.MESSAGE_ID_MULTISIG,
    args.context,
  );

  console.log(JSON.stringify(config, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
