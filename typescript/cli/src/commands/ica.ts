import { type CommandModule } from 'yargs';

import { type CommandModuleWithWriteContext } from '../context/types.js';
import { runIcaDeploy } from '../deploy/ica.js';
import { log, logCommandHeader } from '../logger.js';

import {
  addressCommandOption,
  chainCommandOption,
  stringArrayOptionConfig,
} from './options.js';

/**
 * Parent command
 */
export const icaCommand: CommandModule = {
  command: 'ica',
  describe: 'Manage Interchain Accounts (ICAs)',
  builder: (yargs) => yargs.command(deploy).version(false).demandCommand(),
  handler: () => log('Command required'),
};

/**
 * Deploys Interchain Accounts (ICAs) for a specified owner on destination chains.
 */
export const deploy: CommandModuleWithWriteContext<{
  origin: string;
  chains: string[];
  owner: string;
}> = {
  command: 'deploy',
  describe:
    'Deploy Interchain Accounts (ICAs) on destination chains for a specified owner on the origin chain',
  builder: {
    origin: {
      ...chainCommandOption,
      description:
        'The origin chain where the owner address lives. Ethereum is used by default',
      default: 'ethereum',
    },
    chains: {
      ...stringArrayOptionConfig({
        description: 'List of chains for ICA deployment',
        demandOption: true,
      }),
    },
    owner: {
      ...addressCommandOption(
        'The address of the ICA owner on the origin chain',
      ),
      demandOption: true,
    },
  },
  handler: async ({ context, origin, chains, owner }) => {
    logCommandHeader('Hyperlane ICA Deploy');

    await runIcaDeploy({
      context,
      origin,
      chains,
      owner,
    });

    process.exit(0);
  },
};
