import { EvmHookReader, EvmIsmReader, chainMetadata } from '@hyperlane-xyz/sdk';

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
// Fallback routing hook on polygon (may take 6s):
//     yarn tsx scripts/read-config.ts -e mainnet3 --type hook --network polygon --address 0xca4cCe24E7e06241846F5EA0cda9947F0507C40C
// IGP hook on inevm (may take 5s):
//     yarn tsx scripts/read-config.ts -e mainnet3 --type hook --network inevm --address 0x19dc38aeae620380430C200a6E990D5Af5480117
// Top-level aggregation ISM on celo (may take 14s)
//     yarn tsx scripts/read-config.ts -e mainnet3 --type ism --network celo --address 0x99e8E56Dce3402D6E09A82718937fc1cA2A9491E
// Aggregation ISM for bsc domain on inevm (may take 5s)
//     yarn tsx scripts/read-config.ts -e mainnet3 --type ism --network inevm --address 0x79A7c7Fe443971CBc6baD623Fdf8019C379a7178

async function readConfig() {
  const { environment, network, context, type, address, disableConcurrency } =
    await withContext(withNetwork(getArgs()))
      .option('type', {
        describe: 'Specify the type of config to read',
        choices: ['ism', 'hook'],
        demandOption: true,
      })
      .boolean('disableConcurrency')
      .describe(
        'disableConcurrency',
        'option to disable parallel iteration over domains',
      )
      .string('address')
      .describe('address', 'config address')
      .demandOption('address')
      .demandOption('network').argv;

  const multiProvider = await getMultiProviderForRole(
    chainMetadata[network].isTestnet ? testnetConfigs : mainnetConfigs,
    environment,
    context,
    Role.Deployer,
  );

  if (type === 'ism') {
    const ismReader = new EvmIsmReader(
      multiProvider,
      network,
      disableConcurrency,
    );
    const config = await ismReader.deriveIsmConfig(address);
    console.log(EvmIsmReader.stringifyConfig(config, 2));
  } else if (type === 'hook') {
    const hookReader = new EvmHookReader(
      multiProvider,
      network,
      disableConcurrency,
    );
    const config = await hookReader.deriveHookConfig(address);
    console.log(EvmHookReader.stringifyConfig(config, 2));
  } else {
    console.error('Invalid type specified. Please use "ism" or "hook".');
    process.exit(1);
  }
}

readConfig()
  .then()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
