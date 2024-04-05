import { EvmHookReader, chainMetadata } from '@hyperlane-xyz/sdk';

import { mainnetConfigs } from '../config/environments/mainnet3/chains.js';
import { testnetConfigs } from '../config/environments/testnet4/chains.js';
import { Role } from '../src/roles.js';

import {
  getArgs,
  getMultiProviderForRole,
  withContext,
  withNetwork,
} from './agent-utils.js';

async function readHook() {
  const { environment, network, hookAddress, context } = await withContext(
    withNetwork(getArgs()),
  )
    .string('hookAddress')
    .describe('hookAddress', 'hook address')
    .demandOption('hookAddress')
    .demandOption('network').argv;

  // manually create multiprovider because envConfig multiprovider excludes non-EVM chains
  const multiProvider = await getMultiProviderForRole(
    chainMetadata[network].isTestnet ? testnetConfigs : mainnetConfigs,
    environment,
    context,
    Role.Deployer,
  );

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
