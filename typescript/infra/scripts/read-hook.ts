import { EvmHookReader } from '@hyperlane-xyz/sdk';

import { getArgs, withContext, withNetwork } from './agent-utils.js';
import { getEnvironmentConfig } from './core-utils.js';

async function readHook() {
  const { environment, network, hookAddress } = await withContext(
    withNetwork(getArgs()),
  )
    .string('hookAddress')
    .describe('hookAddress', 'hook address')
    .demandOption('hookAddress')
    .demandOption('network').argv;
  const envConfig = getEnvironmentConfig(environment);
  const multiProvider = await envConfig.getMultiProvider();
  const hookReader = new EvmHookReader(multiProvider, network);
  const config = await hookReader.deriveHookConfig(hookAddress);
  console.log(EvmHookReader.stringifyConfig(config, 2));
}

readHook()
  .then()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
