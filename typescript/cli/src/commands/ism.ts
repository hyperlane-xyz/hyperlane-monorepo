import { CommandModule } from 'yargs';

import { readIsmConfig } from '../ism/read.js';
import { log } from '../logger.js';

import {
  addressCommandOption,
  chainCommandOption,
  chainsCommandOption,
  concurrencyCommandOption,
  fileFormatOption,
  outputFileOption,
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

export const read: CommandModule = {
  command: 'read',
  describe: 'Reads onchain ISM configuration for a given address',
  builder: (yargs) =>
    yargs.options({
      chains: chainsCommandOption,
      chain: {
        ...chainCommandOption,
        demandOption: true,
      },
      address: {
        ...addressCommandOption,
        demandOption: true,
      },
      concurrency: concurrencyCommandOption,
      format: fileFormatOption,
      output: outputFileOption(),
    }),
  handler: async (argv: any) => {
    await readIsmConfig({
      chain: argv.chain,
      address: argv.address,
      chainConfigPath: argv.chains,
      concurrency: argv.concurrency,
      format: argv.format,
      output: argv.output,
    });
    process.exit(0);
  },
};
