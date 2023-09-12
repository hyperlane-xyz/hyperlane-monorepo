import { AllChains, ModuleType } from '@hyperlane-xyz/sdk';

import { multisigIsms } from '../config/aggregationIsm';

import { getArgs, withContext } from './utils';

async function main() {
  const args = await withContext(getArgs())
    .describe('local', 'local chain')
    .choices('local', AllChains)
    .demandOption('local').argv;

  const config = multisigIsms(
    args.environment,
    args.local,
    ModuleType.LEGACY_MULTISIG,
    args.context,
  );

  console.log(JSON.stringify(config, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
