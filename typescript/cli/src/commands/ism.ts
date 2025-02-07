import { CommandModule } from 'yargs';

import { CommandModuleWithContext } from '../context/types.js';
import { readIsmConfig } from '../ism/read.js';
import { log, logGray } from '../logger.js';

import {
  addressCommandOption,
  chainCommandOption,
  outputFileCommandOption,
} from './options.js';

/**
 * Parent command
 */
export const ismCommand: CommandModule = {
  command: 'ism',
  describe: 'Operations relating to ISMs',
  builder: (yargs) => yargs.command(read).version(false).demandCommand(),
  handler: () => log('Command required'),
};

// Examples for testing:
// Top-level aggregation ISM on celo (may take 10s)
//     hyperlane ism read --chain celo --address 0x99e8E56Dce3402D6E09A82718937fc1cA2A9491E
// Aggregation ISM for bsc domain on inevm (may take 5s)
//     hyperlane ism read --chain inevm --address 0x79A7c7Fe443971CBc6baD623Fdf8019C379a7178
// Test ISM on alfajores testnet
//     hyperlane ism read --chain alfajores --address 0xdB52E4853b6A40D2972E6797E0BDBDb3eB761966
export const read: CommandModuleWithContext<{
  chain: string;
  address: string;
  out: string;
}> = {
  command: 'read',
  describe: 'Reads onchain ISM configuration for a given address',
  builder: {
    chain: {
      ...chainCommandOption,
      demandOption: true,
    },
    address: addressCommandOption(
      'Address of the Interchain Security Module to read.',
      true,
    ),
    out: outputFileCommandOption(),
  },
  handler: async (argv) => {
    logGray('Hyperlane ISM Read');
    logGray('------------------');
    await readIsmConfig(argv);
    process.exit(0);
  },
};
