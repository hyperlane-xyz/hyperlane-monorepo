import { CommandModule } from 'yargs';

import { CommandModuleWithContext } from '../context/types.js';
import { readHookConfig } from '../hook/read.js';
import { log, logGray } from '../logger.js';

import {
  addressCommandOption,
  chainCommandOption,
  outputFileCommandOption,
} from './options.js';

/**
 * Parent command
 */
export const hookCommand: CommandModule = {
  command: 'hook',
  describe: 'Operations relating to Hooks',
  builder: (yargs) => yargs.command(read).version(false).demandCommand(),
  handler: () => log('Command required'),
};

// Examples for testing:
// Fallback routing hook on polygon (may take 5s):
//     hyperlane hook read --chain polygon --address 0xca4cCe24E7e06241846F5EA0cda9947F0507C40C
// IGP hook on inevm (may take 5s):
//     hyperlane hook read --chain inevm --address 0x19dc38aeae620380430C200a6E990D5Af5480117
export const read: CommandModuleWithContext<{
  chain: string;
  address: string;
  out: string;
}> = {
  command: 'read',
  describe: 'Reads onchain Hook configuration for a given address',
  builder: {
    chain: {
      ...chainCommandOption,
      demandOption: true,
    },
    address: addressCommandOption('Address of the Hook to read.', true),
    out: outputFileCommandOption(),
  },
  handler: async (args) => {
    logGray('Hyperlane Hook Read');
    logGray('------------------');
    await readHookConfig(args);
    process.exit(0);
  },
};
