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

// Examples from <monorepo>/typescript/infra:
// Fallback routing hook on arbitrum (may take 2-3 minutes):
//     yarn tsx scripts/read-hook.ts -e mainnet3 --network arbitrum --hookAddress 0x9e8fFb1c26099e75Dd5D794030e2E9AA51471c25
// IGP hook on inevm (may take 15s):
//     yarn tsx scripts/read-hook.ts -e mainnet3 --network inevm --hookAddress 0x19dc38aeae620380430C200a6E990D5Af5480117

async function readHook() {
  const { environment, network, hookAddress, context, disableConcurrency } =
    await withContext(withNetwork(getArgs()))
      .string('hookAddress')
      .describe('hookAddress', 'hook address')
      .boolean('disableConcurrency')
      .describe(
        'disableConcurrency',
        'option to disable parallel iteration over hook domains',
      )
      .demandOption('hookAddress')
      .demandOption('network').argv;

  // manually create multiprovider because envConfig multiprovider excludes non-EVM chains
  const multiProvider = await getMultiProviderForRole(
    chainMetadata[network].isTestnet ? testnetConfigs : mainnetConfigs,
    environment,
    context,
    Role.Deployer,
  );

  const hookReader = new EvmHookReader(
    multiProvider,
    network,
    disableConcurrency,
  );
  const config = await hookReader.deriveHookConfig(hookAddress);
  console.log(EvmHookReader.stringifyConfig(config, 2));
}

readHook()
  .then()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
